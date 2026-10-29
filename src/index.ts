import "dotenv/config";
import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { pool } from "./db";
import { allowRoles, AuthRequest, requireAuth, signToken } from "./auth";
import { startTelegramBot } from "./telegram";

const app = express();
app.disable("x-powered-by");
app.use(cors({ origin: (process.env.CORS_ORIGIN || "http://localhost:3000").split(",").map((v) => v.trim()), credentials: false }));
app.use(express.json({ limit: "1mb" }));
const money = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

app.get("/health", async (_req, res) => {
  try { await pool.query("SELECT 1"); res.json({ status: "ok", database: "connected" }); }
  catch { res.status(503).json({ status: "degraded", database: "unavailable" }); }
});

app.post("/api/auth/login", async (req, res, next) => {
  try {
    const input = z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(200) }).parse(req.body);
    const result = await pool.query("SELECT id, username, password_hash, role, branch_id, is_active FROM users WHERE username = $1 LIMIT 1", [input.username]);
    const user = result.rows[0];
    if (!user || !user.is_active || !(await bcrypt.compare(input.password, user.password_hash))) return res.status(401).json({ error: "Login yoki parol noto‘g‘ri" });
    const payload = { id: String(user.id), username: user.username, role: user.role, branchId: user.branch_id ? String(user.branch_id) : null };
    res.json({ token: signToken(payload), user: { id: payload.id, username: payload.username, role: payload.role } });
  } catch (error) { next(error); }
});

app.use("/api", requireAuth);
app.get("/api/me", (req: AuthRequest, res) => res.json({ user: req.user }));

app.get("/api/dashboard", async (req: AuthRequest, res, next) => {
  try {
    const branchId = req.user?.branchId;
    const branchFilter = branchId ? " AND branch_id = $1" : "";
    const params = branchId ? [branchId] : [];
    const [sales, expenses, products, debts] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(total_amount),0) AS total, COALESCE(SUM(gross_profit),0) AS gross_profit, COUNT(*)::int AS count FROM sales WHERE status='completed' AND sold_at::date=CURRENT_DATE${branchFilter}`, params),
      pool.query(`SELECT COALESCE(SUM(amount),0) AS total FROM expenses WHERE expense_date=CURRENT_DATE${branchFilter}`, params),
      pool.query(`SELECT COUNT(*)::int AS count, COUNT(*) FILTER (WHERE stock_quantity <= min_stock)::int AS low_stock FROM products WHERE is_active=true${branchFilter}`, params),
      pool.query(`SELECT COALESCE(SUM(remaining_amount),0) AS total FROM debts WHERE status='open'${branchFilter}`, params),
    ]);
    const salesTotal = Number(sales.rows[0]?.total || 0);
    const expenseTotal = Number(expenses.rows[0]?.total || 0);
    const grossProfit = Number(sales.rows[0]?.gross_profit || 0);
    res.json({ date: new Date().toISOString().slice(0, 10), currency: "UZS", sales: salesTotal, salesCount: sales.rows[0]?.count || 0, expenses: expenseTotal, grossProfit, estimatedOperatingProfit: money(grossProfit - expenseTotal), productCount: products.rows[0]?.count || 0, lowStockCount: products.rows[0]?.low_stock || 0, openDebt: Number(debts.rows[0]?.total || 0), note: "Taxminiy operatsion foyda yalpi foydadan qayd qilingan xarajatlarni ayiradi; soliq va boshqa hisoblar alohida tekshiriladi." });
  } catch (error) { next(error); }
});

app.get("/api/products", async (req: AuthRequest, res, next) => {
  try {
    const q = String(req.query.q || "").trim();
    const branchId = req.user?.branchId;
    const values: unknown[] = [];
    let where = "WHERE p.is_active = true";
    if (branchId) { values.push(branchId); where += ` AND p.branch_id = $${values.length}`; }
    if (q) { values.push(`%${q}%`); where += ` AND (p.name ILIKE $${values.length} OR p.barcode ILIKE $${values.length})`; }
    const result = await pool.query(`SELECT p.id, p.name, p.barcode, p.unit, p.purchase_price, p.sale_price, p.stock_quantity, p.min_stock, p.expiry_date FROM products p ${where} ORDER BY p.name LIMIT 500`, values);
    res.json({ items: result.rows });
  } catch (error) { next(error); }
});

app.post("/api/products", allowRoles("owner", "manager", "warehouse"), async (req: AuthRequest, res, next) => {
  try {
    const input = z.object({ name: z.string().min(1).max(200), barcode: z.string().max(100).optional().nullable(), unit: z.enum(["dona","kg","g","l","ml","quti","pachka"]).default("dona"), purchasePrice: z.number().nonnegative(), salePrice: z.number().nonnegative(), stockQuantity: z.number().nonnegative().default(0), minStock: z.number().nonnegative().default(0), expiryDate: z.string().date().optional().nullable() }).parse(req.body);
    const result = await pool.query("INSERT INTO products (name, barcode, unit, purchase_price, sale_price, stock_quantity, min_stock, expiry_date, branch_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *", [input.name,input.barcode || null,input.unit,input.purchasePrice,input.salePrice,input.stockQuantity,input.minStock,input.expiryDate || null,req.user?.branchId,req.user?.id]);
    if (input.stockQuantity > 0) await pool.query("INSERT INTO stock_movements (product_id,movement_type,quantity_delta,unit_cost,note,branch_id,created_by) VALUES ($1,'opening',$2,$3,'Boshlang‘ich qoldiq',$4,$5)", [result.rows[0].id,input.stockQuantity,input.purchasePrice,req.user?.branchId,req.user?.id]);
    res.status(201).json({ item: result.rows[0] });
  } catch (error) { next(error); }
});

app.get("/api/sales", async (req: AuthRequest, res, next) => {
  try {
    const branchId = req.user?.branchId;
    const result = await pool.query("SELECT id, receipt_number, subtotal, discount_amount, total_amount, cost_amount, gross_profit, payment_method, status, sold_at FROM sales WHERE ($1::uuid IS NULL OR branch_id=$1) ORDER BY sold_at DESC LIMIT 200", [branchId || null]);
    res.json({ items: result.rows });
  } catch (error) { next(error); }
});

app.post("/api/sales", allowRoles("owner", "manager", "cashier"), async (req: AuthRequest, res, next) => {
  const schema = z.object({
    items: z.array(z.object({ productId: z.string().uuid(), quantity: z.number().positive().max(100000) })).min(1).max(100),
    paymentMethod: z.enum(["cash","card","qr","credit"]),
    discountAmount: z.number().nonnegative().default(0),
    customerName: z.string().max(200).optional(),
    note: z.string().max(1000).optional(),
  });
  let input: z.infer<typeof schema>;
  try { input = schema.parse(req.body); }
  catch (error) { return next(error); }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let subtotal = 0;
    let costAmount = 0;
    const lines: Array<{id:string;name:string;quantity:number;price:number;cost:number;total:number;costTotal:number;branchId:string|null}> = [];
    for (const item of input.items) {
      const result = await client.query("SELECT id,name,sale_price,purchase_price,stock_quantity,branch_id FROM products WHERE id=$1 AND is_active=true FOR UPDATE", [item.productId]);
      const product = result.rows[0];
      if (!product) throw Object.assign(new Error("Mahsulot topilmadi"), { statusCode: 404 });
      if (req.user?.branchId && product.branch_id !== req.user.branchId) throw Object.assign(new Error("Mahsulot ushbu filialga tegishli emas"), { statusCode: 403 });
      if (Number(product.stock_quantity) < item.quantity) throw Object.assign(new Error(`“${product.name}” uchun ombor qoldig‘i yetarli emas`), { statusCode: 400 });
      const price = Number(product.sale_price), cost = Number(product.purchase_price);
      const total = money(price * item.quantity), costTotal = money(cost * item.quantity);
      subtotal = money(subtotal + total); costAmount = money(costAmount + costTotal);
      lines.push({ id: String(product.id), name: product.name, quantity: item.quantity, price, cost, total, costTotal, branchId: product.branch_id ? String(product.branch_id) : null });
    }
    if (input.discountAmount > subtotal) throw Object.assign(new Error("Chegirma savdo summasidan ko‘p bo‘lishi mumkin emas"), { statusCode: 400 });
    const totalAmount = money(subtotal - input.discountAmount);
    const grossProfit = money(totalAmount - costAmount);
    if (input.paymentMethod === "credit" && !input.customerName?.trim()) throw Object.assign(new Error("Nasiya savdo uchun mijoz nomini kiriting"), { statusCode: 400 });
    const sale = await client.query("INSERT INTO sales (subtotal,discount_amount,total_amount,cost_amount,gross_profit,payment_method,branch_id,cashier_id,note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,receipt_number,subtotal,discount_amount,total_amount,cost_amount,gross_profit,payment_method,status,sold_at", [subtotal,input.discountAmount,totalAmount,costAmount,grossProfit,input.paymentMethod,req.user?.branchId,req.user?.id,input.note || null]);
    for (const line of lines) {
      await client.query("INSERT INTO sale_items (sale_id,product_id,product_name,quantity,unit_price,unit_cost,line_total,cost_total,gross_profit) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [sale.rows[0].id,line.id,line.name,line.quantity,line.price,line.cost,line.total,line.costTotal,money(line.total-line.costTotal)]);
      await client.query("UPDATE products SET stock_quantity=stock_quantity-$2, updated_at=NOW() WHERE id=$1", [line.id,line.quantity]);
      await client.query("INSERT INTO stock_movements (product_id,movement_type,quantity_delta,unit_cost,reference_type,reference_id,branch_id,created_by) VALUES ($1,'sale',$2,$3,'sale',$4,$5,$6)", [line.id,-line.quantity,line.cost,sale.rows[0].id,req.user?.branchId,req.user?.id]);
    }
    if (input.paymentMethod === "credit") {
      await client.query("INSERT INTO debts (direction,party_name,original_amount,paid_amount,remaining_amount,note,branch_id,created_by) VALUES ('receivable',$1,$2,0,$2,$3,$4,$5)", [input.customerName!.trim(),totalAmount,`Nasiya savdo cheki #${sale.rows[0].receipt_number}`,req.user?.branchId,req.user?.id]);
    } else {
      await client.query("INSERT INTO payments (sale_id,method,amount,created_by) VALUES ($1,$2,$3,$4)", [sale.rows[0].id,input.paymentMethod,totalAmount,req.user?.id]);
    }
    await client.query("INSERT INTO audit_logs (user_id,action,entity_type,entity_id,details) VALUES ($1,'sale.created','sale',$2,$3::jsonb)", [req.user?.id,String(sale.rows[0].id),JSON.stringify({ receiptNumber: sale.rows[0].receipt_number, totalAmount, itemCount: lines.length })]);
    await client.query("COMMIT");
    res.status(201).json({ sale: sale.rows[0], items: lines.map(({id,name,quantity,price,total}) => ({ productId:id,name,quantity,unitPrice:price,total })) });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally { client.release(); }
});

app.get("/api/expenses", async (_req, res, next) => {
  try { const result = await pool.query("SELECT id,title,category,amount,expense_date,note FROM expenses ORDER BY expense_date DESC,created_at DESC LIMIT 200"); res.json({ items: result.rows }); }
  catch (error) { next(error); }
});

app.post("/api/expenses", allowRoles("owner", "manager", "accountant"), async (req: AuthRequest, res, next) => {
  try {
    const input = z.object({ title: z.string().min(1).max(200), category: z.string().min(1).max(100), amount: z.number().positive(), expenseDate: z.string().date().optional(), note: z.string().max(1000).optional() }).parse(req.body);
    const result = await pool.query("INSERT INTO expenses (title,category,amount,expense_date,note,branch_id,created_by) VALUES ($1,$2,$3,COALESCE($4,CURRENT_DATE),$5,$6,$7) RETURNING *", [input.title,input.category,input.amount,input.expenseDate || null,input.note || null,req.user?.branchId,req.user?.id]);
    res.status(201).json({ item: result.rows[0] });
  } catch (error) { next(error); }
});

app.get("/api/debts", async (req: AuthRequest, res, next) => {
  try {
    const result = await pool.query("SELECT id,direction,party_name,phone,original_amount,paid_amount,remaining_amount,due_date,status,created_at FROM debts WHERE ($1::uuid IS NULL OR branch_id=$1) ORDER BY created_at DESC LIMIT 300", [req.user?.branchId || null]);
    res.json({ items: result.rows });
  } catch (error) { next(error); }
});

app.post("/api/debts", allowRoles("owner", "manager", "accountant"), async (req: AuthRequest, res, next) => {
  try {
    const input = z.object({ direction: z.enum(["receivable","payable"]), partyName: z.string().min(1).max(200), phone: z.string().max(40).optional(), amount: z.number().positive(), dueDate: z.string().date().optional(), note: z.string().max(1000).optional() }).parse(req.body);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const debt = await client.query("INSERT INTO debts (direction,party_name,phone,original_amount,paid_amount,remaining_amount,due_date,note,branch_id,created_by) VALUES ($1,$2,$3,$4,0,$4,$5,$6,$7,$8) RETURNING *", [input.direction,input.partyName,input.phone || null,input.amount,input.dueDate || null,input.note || null,req.user?.branchId,req.user?.id]);
      await client.query("INSERT INTO debt_transactions (debt_id,transaction_type,amount,note,created_by) VALUES ($1,'created',$2,$3,$4)", [debt.rows[0].id,input.amount,input.note || "Qarz yaratildi",req.user?.id]);
      await client.query("COMMIT");
      res.status(201).json({ item: debt.rows[0] });
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  } catch (error) { next(error); }
});

app.post("/api/debts/:id/payments", allowRoles("owner", "manager", "accountant"), async (req: AuthRequest, res, next) => {
  try {
    const input = z.object({ amount: z.number().positive(), note: z.string().max(500).optional() }).parse(req.body);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query("SELECT * FROM debts WHERE id=$1 FOR UPDATE", [req.params.id]);
      if (!found.rowCount) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Qarz topilmadi" }); }
      const debt = found.rows[0];
      if (input.amount > Number(debt.remaining_amount)) { await client.query("ROLLBACK"); return res.status(400).json({ error: "To‘lov qolgan qarzdan ko‘p" }); }
      const updated = await client.query("UPDATE debts SET paid_amount=paid_amount+$2,remaining_amount=remaining_amount-$2,status=CASE WHEN remaining_amount-$2=0 THEN 'paid' ELSE 'open' END,updated_at=NOW() WHERE id=$1 RETURNING *", [req.params.id,input.amount]);
      await client.query("INSERT INTO debt_transactions (debt_id,transaction_type,amount,note,created_by) VALUES ($1,'payment',$2,$3,$4)", [req.params.id,input.amount,input.note || null,req.user?.id]);
      await client.query("COMMIT");
      res.json({ item: updated.rows[0] });
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  } catch (error) { next(error); }
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof z.ZodError) return res.status(400).json({ error: "Ma’lumot noto‘g‘ri", details: error.flatten() });
  const statusCode = typeof error === "object" && error !== null && "statusCode" in error ? Number((error as {statusCode: unknown}).statusCode) : 500;
  if (statusCode >= 500) console.error(error);
  res.status(statusCode).json({ error: error instanceof Error && statusCode < 500 ? error.message : "Serverda kutilmagan xatolik" });
});

const port = Number(process.env.PORT || 4000);
app.listen(port, () => {
  console.log(`Magazin API listening on :${port}`);
  startTelegramBot().catch((error) => console.error("Telegram bot failed to start", error));
});

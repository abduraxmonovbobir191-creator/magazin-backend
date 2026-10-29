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
    const params = branchId ? [branchId] : [];
    const where = branchId ? "WHERE branch_id = $1" : "";
    const [sales, expenses, products, debts] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(total_amount),0) AS total, COUNT(*)::int AS count FROM sales ${where} AND status = 'completed' `.replace("WHERE  AND", "WHERE").replace("FROM sales  AND", "FROM sales WHERE"), params),
      pool.query(`SELECT COALESCE(SUM(amount),0) AS total FROM expenses ${where ? where + " AND " : "WHERE "}expense_date = CURRENT_DATE`, params),
      pool.query(`SELECT COUNT(*)::int AS count, COUNT(*) FILTER (WHERE stock_quantity <= min_stock)::int AS low_stock FROM products WHERE is_active = true ${branchId ? "AND branch_id = $1" : ""}`, params),
      pool.query(`SELECT COALESCE(SUM(remaining_amount),0) AS total FROM debts WHERE status = 'open' ${branchId ? "AND branch_id = $1" : ""}`, params),
    ]);
    const salesTotal = Number(sales.rows[0]?.total || 0);
    const expenseTotal = Number(expenses.rows[0]?.total || 0);
    res.json({ date: new Date().toISOString().slice(0, 10), currency: "UZS", sales: salesTotal, salesCount: sales.rows[0]?.count || 0, expenses: expenseTotal, grossProfit: null, netOperatingBeforeCogs: salesTotal - expenseTotal, productCount: products.rows[0]?.count || 0, lowStockCount: products.rows[0]?.low_stock || 0, openDebt: Number(debts.rows[0]?.total || 0), note: "Aniq foyda sotilgan mahsulot tannarxi va qaytarishlar hisobga olingach hisoblanadi." });
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
    const branchId = req.user?.branchId;
    const result = await pool.query(`INSERT INTO products (name, barcode, unit, purchase_price, sale_price, stock_quantity, min_stock, expiry_date, branch_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [input.name, input.barcode || null, input.unit, input.purchasePrice, input.salePrice, input.stockQuantity, input.minStock, input.expiryDate || null, branchId, req.user?.id]);
    res.status(201).json({ item: result.rows[0] });
  } catch (error) { next(error); }
});

app.get("/api/expenses", async (_req, res, next) => {
  try { const result = await pool.query("SELECT id, title, category, amount, expense_date, note FROM expenses ORDER BY expense_date DESC, created_at DESC LIMIT 200"); res.json({ items: result.rows }); }
  catch (error) { next(error); }
});

app.post("/api/expenses", allowRoles("owner", "manager", "accountant"), async (req: AuthRequest, res, next) => {
  try {
    const input = z.object({ title: z.string().min(1).max(200), category: z.string().min(1).max(100), amount: z.number().positive(), expenseDate: z.string().date().optional(), note: z.string().max(1000).optional() }).parse(req.body);
    const result = await pool.query("INSERT INTO expenses (title, category, amount, expense_date, note, branch_id, created_by) VALUES ($1,$2,$3,COALESCE($4,CURRENT_DATE),$5,$6,$7) RETURNING *", [input.title,input.category,input.amount,input.expenseDate || null,input.note || null,req.user?.branchId,req.user?.id]);
    res.status(201).json({ item: result.rows[0] });
  } catch (error) { next(error); }
});

app.get("/api/debts", async (req: AuthRequest, res, next) => {
  try {
    const result = await pool.query("SELECT id, direction, party_name, phone, original_amount, paid_amount, remaining_amount, due_date, status, created_at FROM debts WHERE ($1::uuid IS NULL OR branch_id = $1) ORDER BY created_at DESC LIMIT 300", [req.user?.branchId || null]);
    res.json({ items: result.rows });
  } catch (error) { next(error); }
});

app.post("/api/debts", allowRoles("owner", "manager", "accountant"), async (req: AuthRequest, res, next) => {
  try {
    const input = z.object({ direction: z.enum(["receivable","payable"]), partyName: z.string().min(1).max(200), phone: z.string().max(40).optional(), amount: z.number().positive(), dueDate: z.string().date().optional(), note: z.string().max(1000).optional() }).parse(req.body);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const debt = await client.query("INSERT INTO debts (direction, party_name, phone, original_amount, paid_amount, remaining_amount, due_date, note, branch_id, created_by) VALUES ($1,$2,$3,$4,0,$4,$5,$6,$7,$8) RETURNING *", [input.direction,input.partyName,input.phone || null,input.amount,input.dueDate || null,input.note || null,req.user?.branchId,req.user?.id]);
      await client.query("INSERT INTO debt_transactions (debt_id, transaction_type, amount, note, created_by) VALUES ($1,'created',$2,$3,$4)", [debt.rows[0].id,input.amount,input.note || "Qarz yaratildi",req.user?.id]);
      await client.query("COMMIT");
      res.status(201).json({ item: debt.rows[0] });
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  } catch (error) { next(error); }
});

app.post("/api/debts/:id/payments", allowRoles("owner", "manager", "accountant"), async (req: AuthRequest, res, next) => {
  const amountSchema = z.object({ amount: z.number().positive(), note: z.string().max(500).optional() });
  try {
    const input = amountSchema.parse(req.body);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query("SELECT * FROM debts WHERE id=$1 FOR UPDATE", [req.params.id]);
      if (!found.rowCount) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Qarz topilmadi" }); }
      const debt = found.rows[0];
      if (input.amount > Number(debt.remaining_amount)) { await client.query("ROLLBACK"); return res.status(400).json({ error: "To‘lov qolgan qarzdan ko‘p" }); }
      const updated = await client.query("UPDATE debts SET paid_amount=paid_amount+$2, remaining_amount=remaining_amount-$2, status=CASE WHEN remaining_amount-$2=0 THEN 'paid' ELSE 'open' END, updated_at=NOW() WHERE id=$1 RETURNING *", [req.params.id,input.amount]);
      await client.query("INSERT INTO debt_transactions (debt_id, transaction_type, amount, note, created_by) VALUES ($1,'payment',$2,$3,$4)", [req.params.id,input.amount,input.note || null,req.user?.id]);
      await client.query("COMMIT");
      res.json({ item: updated.rows[0] });
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  } catch (error) { next(error); }
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof z.ZodError) return res.status(400).json({ error: "Ma’lumot noto‘g‘ri", details: error.flatten() });
  console.error(error);
  res.status(500).json({ error: "Serverda kutilmagan xatolik" });
});

const port = Number(process.env.PORT || 4000);
app.listen(port, () => {
  console.log(`Magazin API listening on :${port}`);
  startTelegramBot().catch((error) => console.error("Telegram bot failed to start", error));
});

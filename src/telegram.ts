import { Bot } from "grammy";
import { pool } from "./db";

export async function startTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { console.log("Telegram bot disabled: TELEGRAM_BOT_TOKEN is not configured"); return; }
  const allowed = new Set((process.env.TELEGRAM_ADMIN_CHAT_IDS || "").split(",").map((v) => v.trim()).filter(Boolean));
  const bot = new Bot(token);
  bot.command("start", async (ctx) => {
    if (!allowed.has(String(ctx.chat.id))) { await ctx.reply("Bu bot faqat ruxsat berilgan magazin administratorlari uchun."); return; }
    await ctx.reply("🛒 Magazin boshqaruvi\n/today — bugungi savdo hisoboti\n/lowstock — kam qolgan mahsulotlar");
  });
  bot.command(["today", "lowstock"], async (ctx) => {
    if (!allowed.has(String(ctx.chat.id))) { await ctx.reply("Sizga bu amal uchun ruxsat berilmagan."); return; }
    try {
      if (ctx.message?.text?.startsWith("/lowstock")) {
        const result = await pool.query("SELECT name, stock_quantity, unit FROM products WHERE is_active=true AND stock_quantity <= min_stock ORDER BY stock_quantity ASC LIMIT 20");
        await ctx.reply(result.rowCount ? "⚠️ Kam qolgan mahsulotlar:\n" + result.rows.map((p) => `• ${p.name}: ${p.stock_quantity} ${p.unit}`).join("\n") : "✅ Minimal qoldiqdan past mahsulot yo‘q.");
      } else {
        const result = await pool.query("SELECT COALESCE(SUM(total_amount),0) AS sales, COUNT(*)::int AS count FROM sales WHERE status='completed' AND sold_at::date=CURRENT_DATE");
        const expenses = await pool.query("SELECT COALESCE(SUM(amount),0) AS total FROM expenses WHERE expense_date=CURRENT_DATE");
        await ctx.reply(`📊 Bugungi hisobot\nSavdolar: ${result.rows[0].count}\nTushum: ${Number(result.rows[0].sales).toLocaleString("uz-UZ")} so‘m\nXarajat: ${Number(expenses.rows[0].total).toLocaleString("uz-UZ")} so‘m\n\nBu sof foyda emas; tannarx alohida hisoblanadi.`);
      }
    } catch { await ctx.reply("Hisobotni olishda xatolik. Server va bazani tekshiring."); }
  });
  bot.catch((error) => console.error("Telegram bot error", error));
  await bot.start({ onStart: (info) => console.log(`Telegram bot @${info.username} started`) });
}

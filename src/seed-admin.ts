import "dotenv/config";
import bcrypt from "bcryptjs";
import { pool } from "./db";

async function main() {
  const username = process.env.ADMIN_USERNAME?.trim();
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password || password.length < 14) {
    throw new Error("Set ADMIN_USERNAME and a strong ADMIN_PASSWORD (at least 14 characters) in the private environment.");
  }
  const existing = await pool.query("SELECT id FROM users WHERE username=$1", [username]);
  if (existing.rowCount) throw new Error("This username already exists. Use the normal account-management flow instead.");
  const hash = await bcrypt.hash(password, 12);
  await pool.query("INSERT INTO users (username,password_hash,full_name,role) VALUES ($1,$2,$3,'owner')", [username,hash,username]);
  console.log("Initial owner account created. Remove ADMIN_USERNAME and ADMIN_PASSWORD from the environment now.");
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());

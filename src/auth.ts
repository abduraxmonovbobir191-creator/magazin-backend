import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export type Role = "owner" | "manager" | "cashier" | "warehouse" | "accountant" | "auditor";
export interface AuthUser { id: string; username: string; role: Role; branchId: string | null }
export interface AuthRequest extends Request { user?: AuthUser }

const secret = () => {
  const value = process.env.JWT_SECRET;
  if (!value || value.length < 32) throw new Error("JWT_SECRET must be set to at least 32 characters");
  return value;
};

export function signToken(user: AuthUser): string {
  return jwt.sign(user, secret(), { expiresIn: "8h", issuer: "magazin-api" });
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const token = req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "Kirish talab qilinadi" });
  try {
    req.user = jwt.verify(token, secret(), { issuer: "magazin-api" }) as AuthUser;
    next();
  } catch {
    return res.status(401).json({ error: "Sessiya tugagan yoki token noto‘g‘ri" });
  }
}

export function allowRoles(...roles: Role[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) return res.status(403).json({ error: "Bu amal uchun ruxsat yo‘q" });
    next();
  };
}

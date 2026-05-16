import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db } from "@repo/db";
import { usersTable } from "@repo/db/schema";
import { eq, desc } from "drizzle-orm";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import { authMiddleware } from "../middlewares/auth";

export interface JwtPayload {
  userId: number;
  email: string;
}

const router: IRouter = Router();
const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";

/* ── POST /auth/register ───────────────────────────────────────── */
router.post("/auth/register", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, email, password } = req.body as Record<string, string>;

    if (!name?.trim() || !email?.trim() || !password?.trim()) {
      res.status(400).json({ error: "الاسم والبريد الإلكتروني وكلمة المرور مطلوبة" });
      return;
    }
    if (password.length < 6) {
      res.status(400).json({ error: "كلمة المرور يجب أن تكون 6 أحرف على الأقل" });
      return;
    }

    const password_hash = await bcrypt.hash(password, 10);
    const user = await db
      .insert(usersTable)
      .values({ name, email: email.toLowerCase(), password_hash })
      .returning({ id: usersTable.id, name: usersTable.name, email: usersTable.email });

    const token = jwt.sign({ userId: user.id, email: user.email } satisfies JwtPayload, JWT_SECRET, { expiresIn: "30d" });
    res.status(201).json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) { next(err); }
});

/* ── POST /auth/login ───────────────────────────────────────── */
router.post("/auth/login", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = req.body as Record<string, string>;

    if (!email?.trim() || !password?.trim()) {
      res.status(400).json({ error: "البريد الإلكتروني وكلمة المرور مطلوبان" });
      return;
    }

    const [user] = await db.select()
      .from(usersTable).where(eq(usersTable.email, email.toLowerCase())).limit(1);

    if (!user) {
      res.status(401).json({ error: "البريد الإلكتروني أو كلمة المرور غير صحيحة" });
      return;
    }

    if (!user.password_hash) {
      res.status(401).json({ error: "هذا الحساب يستخدم تسجيل الدخول الاجتماعي — استخدم مزود الدخول المرتبط" });
      return;
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      res.status(401).json({ error: "البريد الإلكتروني أو كلمة المرور غير صحيحة" });
      return;
    }

    const token = jwt.sign({ userId: user.id, email: user.email } satisfies JwtPayload, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) { next(err); }
});

/* ── GET /auth/me ───────────────────────────────────────────── */
router.get("/auth/me", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = (req as Request & { user: JwtPayload }).user;
    const [user] = await db.select({
      id: usersTable.id, name: usersTable.name,
      email: usersTable.email, avatar: usersTable.avatar, created_at: usersTable.created_at,
    }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);

    if (!user) { res.status(404).json({ error: "المستخدم غير موجود" }); return; }
    res.json(user);
  } catch (err) { next(err); }
});

/* ── POST /auth/request-reset ─────────────────────────────────── */
router.post("/auth/request-reset", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email } = req.body as Record<string, string>;
    if (!email?.trim()) {
      res.status(400).json({ error: "البريد الإلكتروني مطلوب" }); return;
    }

    const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email.toLowerCase())).limit(1);
    if (!user) {
      res.status(404).json({ error: "البريد الإلكتروني غير مسجل" }); return;
    }

    const reset_otp = Math.floor(100000 + Math.random() * 900000).toString();
    const reset_otp_exp = new Date(Date.now() + 15 * 60 * 1000);

    await db.update(usersTable).set({ reset_otp, reset_otp_exp }).where(eq(usersTable.id, user.id));
    res.json({ message: "تم إرسال رمز إعادة تعيين إلى بريدك الإلكتروني" });
  } catch (err) { next(err); }
});

/* ── POST /auth/reset-password ────────────────────────────────── */
router.post("/auth/reset-password", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, otp, newPassword } = req.body as { email?: string; otp?: string; newPassword?: string };

    if (!email?.trim() || !otp?.trim() || !newPassword?.trim()) {
      res.status(400).json({ error: "البريد، الرمز، وكلمة المرور الجديدة مطلوبة" }); return;
    }
    if (newPassword.length < 6) {
      res.status(400).json({ error: "كلمة المرور يجب أن تكون 6 أحرف على الأقل" }); return;
    }

    const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email.toLowerCase())).limit(1);
    if (!user) {
      res.status(404).json({ error: "المستخدم غير موجود" }); return;
    }

    if (user.reset_otp !== otp || !user.reset_otp_exp || user.reset_otp_exp < new Date()) {
      res.status(400).json({ error: "الرمز غير صحيح أو انتهت صلاحيته" }); return;
    }

    const password_hash = await bcrypt.hash(newPassword, 10);
    await db.update(usersTable)
      .set({ password_hash, reset_otp: null, reset_otp_exp: null })
      .where(eq(usersTable.id, user.id));

    res.json({ message: "تم تغيير كلمة المرور بنجاح" });
  } catch (err) { next(err); }
});

/* ── PATCH /auth/change-password (T26 - logged in) ─────────── */
router.patch("/auth/change-password", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = (req as Request & { user: JwtPayload }).user;
    const { currentPassword, newPassword } = req.body as { currentPassword?: string; newPassword?: string };

    if (!currentPassword?.trim() || !newPassword?.trim()) {
      res.status(400).json({ error: "كلمة المرور الحالية والجديدة مطلوبتان" }); return;
    }
    if (newPassword.length < 6) {
      res.status(400).json({ error: "كلمة المرور يجب أن تكون 6 أحرف على الأقل" }); return;
    }

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (!user) { res.status(404).json({ error: "المستخدم غير موجود" }); return; }

    if (!user.password_hash) {
      res.status(400).json({ error: "هذا الحساب لا يملك كلمة مرور محلية" }); return;
    }

    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) { res.status(401).json({ error: "كلمة المرور الحالية غير صحيحة" }); return; }

    const password_hash = await bcrypt.hash(newPassword, 10);
    await db.update(usersTable).set({ password_hash }).where(eq(usersTable.id, userId));

    res.json({ message: "تم تغيير كلمة المرور بنجاح" });
  } catch (err) { next(err); }
});

/* ── PATCH /users/me/avatar ──────────────────────────────────── */
router.patch("/users/me/avatar", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = (req as Request & { user: JwtPayload }).user;
    const { avatar } = req.body as { avatar?: string | null };

    if (avatar !== null && avatar !== undefined) {
      if (typeof avatar !== "string") {
        res.status(400).json({ error: "صيغة الصورة غير صحيحة" }); return;
      }
      if (avatar.length > 500_000) {
        res.status(413).json({ error: "حجم الصورة كبير جداً، يُرجى اختيار صورة أصغر" }); return;
      }
      if (avatar !== "" && !avatar.startsWith("data:image/")) {
        res.status(400).json({ error: "يجب أن تكون الصورة بصيغة صحيحة" }); return;
      }
    }

    await db.update(usersTable).set({ avatar: avatar || null }).where(eq(usersTable.id, userId));
    res.json({ message: "تم تحديث الصورة بنجاح" });
  } catch (err) { next(err); }
});

/* ── GET /users/me/recent-products ──────────────────────────── */
router.get("/users/me/recent-products", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = (req as Request & { user: JwtPayload }).user;
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);

    if (!user) { res.status(404).json({ error: "المستخدم غير موجود" }); return; }

    const recent = user.recent_products as number[] || [];
    res.json({ products: recent.slice(0, 10) });
  } catch (err) { next(err); }
});

/* ── POST /users/me/logout ──────────────────────────────────── */
router.post("/users/me/logout", authMiddleware, (req: Request, res: Response) => {
  res.json({ message: "تم تسجيل الخروج بنجاح" });
});

export default router;

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../db';
import { allow, requireAuth, signToken } from '../middleware/auth';
import { HttpError, notFound } from '../lib/errors';
import { idParam } from '../lib/validation';

export const authRouter = Router();

authRouter.post('/auth/login', async (req, res) => {
  const { email, password } = z.object({ email: z.string().trim().toLowerCase(), password: z.string() }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.active || !(await bcrypt.compare(password, user.passwordHash))) {
    throw new HttpError(401, 'Wrong email or password');
  }
  const authUser = { id: user.id, name: user.name, email: user.email, department: user.department };
  res.json({ token: signToken(authUser), user: authUser });
});

authRouter.get('/auth/me', requireAuth, (req, res) => {
  res.json(req.user);
});

// ───────── Users (ADMIN only) ─────────

const DEPARTMENTS = ['ADMIN', 'OPERATIONS', 'SALES', 'FINANCE'] as const;
const userSchema = z.object({
  name: z.string().trim().min(1),
  email: z.string().trim().toLowerCase().email(),
  department: z.enum(DEPARTMENTS),
  active: z.coerce.boolean().optional(),
  password: z.string().min(8, 'At least 8 characters').optional().or(z.literal('')),
});

const publicUser = { id: true, name: true, email: true, department: true, active: true, createdAt: true } as const;

authRouter.get('/users', requireAuth, allow('ADMIN'), async (_req, res) => {
  res.json(await prisma.user.findMany({ select: publicUser, orderBy: { name: 'asc' } }));
});

authRouter.post('/users', requireAuth, allow('ADMIN'), async (req, res) => {
  const { password, ...data } = userSchema.parse(req.body);
  if (!password) throw new HttpError(400, 'Password is required');
  const user = await prisma.user.create({ data: { ...data, passwordHash: await bcrypt.hash(password, 10) }, select: publicUser });
  res.status(201).json(user);
});

authRouter.put('/users/:id', requireAuth, allow('ADMIN'), async (req, res) => {
  const id = idParam(req.params.id);
  const { password, ...data } = userSchema.parse(req.body);
  if (!(await prisma.user.findUnique({ where: { id } }))) throw notFound('User');
  const user = await prisma.user.update({
    where: { id },
    data: { ...data, ...(password ? { passwordHash: await bcrypt.hash(password, 10) } : {}) },
    select: publicUser,
  });
  res.json(user);
});

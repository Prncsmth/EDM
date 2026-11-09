import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { Department } from '@prisma/client';
import { config } from '../config';
import { requestContext, type AuthUser } from '../context';
import { HttpError } from '../lib/errors';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export const signToken = (user: AuthUser) => jwt.sign(user, config.jwtSecret, { expiresIn: '12h' });

/** Requires a valid "Authorization: Bearer <token>" header. */
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(new HttpError(401, 'Not logged in'));
  try {
    const payload = jwt.verify(token, config.jwtSecret) as AuthUser;
    req.user = { id: payload.id, name: payload.name, email: payload.email, department: payload.department };
    requestContext.run({ user: req.user }, () => next());
  } catch {
    next(new HttpError(401, 'Session expired, please log in again'));
  }
}

/** Only the listed departments (and ADMIN) may continue. */
export const allow =
  (...departments: Department[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    const dept = req.user?.department;
    if (dept === 'ADMIN' || (dept && departments.includes(dept))) return next();
    next(new HttpError(403, `Only ${departments.join(', ')} can do this`));
  };

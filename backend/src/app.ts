import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { config } from './config';
import { HttpError } from './lib/errors';
import { requireAuth } from './middleware/auth';
import { authRouter } from './routes/auth';
import { masterRouter } from './routes/master';
import { opsRouter } from './routes/operations';
import { dqRouter } from './routes/dq';
import { insightsRouter } from './routes/insights';

export function createApp() {
  const app = express();
  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use('/api', authRouter); // /auth/login is public; the rest check the token themselves
  app.use('/api', requireAuth, masterRouter, opsRouter, dqRouter, insightsRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // One place that turns every error into a clear JSON response for the frontend.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      return res.status(400).json({
        error: 'Please check the form',
        fields: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      });
    }
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message, ...(err.details ? (err.details as object) : {}) });
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === 'P2002') return res.status(409).json({ error: `Already exists: ${(err.meta?.target as string[] | undefined)?.join(', ') ?? 'duplicate value'}` });
      if (err.code === 'P2003') return res.status(409).json({ error: 'Linked record is missing or still in use' });
      if (err.code === 'P2025') return res.status(404).json({ error: 'Record not found' });
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server' });
  });

  return app;
}

import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT ?? 4000),
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-change-me',
  corsOrigin: (process.env.CORS_ORIGIN ?? 'http://localhost:3000').split(','),
  dqScheduler: process.env.DQ_SCHEDULER !== 'false',
};

// Business constants used by Finance (fisher settlement).
export const SETTLEMENT = {
  portFeeRate: 0.03, // 3% of gross goes to the port
  iceFeePerKg: 2, // ₱2 per kg for ice
  gradeFactor: { A: 1, B: 0.85, C: 0.6 } as Record<string, number>,
};

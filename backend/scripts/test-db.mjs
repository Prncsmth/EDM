// Local in-memory PostgreSQL for testing without Neon (data is lost when stopped).
// Usage: npm run test-db   → then in another terminal: npm run db:migrate && npm run db:seed
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const port = Number(process.env.TEST_DB_PORT ?? 5433);
const db = await PGlite.create({ extensions: { pg_trgm } });
const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
await server.start();
console.log(`Test PostgreSQL (PGlite) running on 127.0.0.1:${port}`);

process.on('SIGINT', async () => {
  await server.stop();
  await db.close();
  process.exit(0);
});

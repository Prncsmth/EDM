// Checks the migrations on a throw-away in-memory database (never touches Neon).
// Usage: node scripts/test-migration.mjs
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import fs from 'node:fs';

const dir = 'prisma/migrations';
const db = await PGlite.create({ extensions: { pg_trgm } });
await db.exec(fs.readFileSync(`${dir}/0001_init/migration.sql`, 'utf8'));

// rows using the OLD department names
await db.exec(`
  INSERT INTO "User"(name, email, "passwordHash", department, "updatedAt") VALUES
    ('a','portops@x','h','PORT_OPS',now()), ('b','qc@x','h','QC',now()), ('c','warehouse@x','h','WAREHOUSE',now()),
    ('d','logistics@x','h','LOGISTICS',now()), ('e','finance@x','h','FINANCE',now()), ('f','admin@x','h','ADMIN',now());
  INSERT INTO "IntegrationEvent"(type, "sourceDept", "targetDept", "entityType", "entityId", message) VALUES
    ('X','QC','LOGISTICS','L',1,'m'), ('Y','SALES',NULL,'L',1,'m');`);

await db.exec(fs.readFileSync(`${dir}/0002_three_departments/migration.sql`, 'utf8'));

const users = (await db.query(`SELECT email, department::text d FROM "User" ORDER BY email`)).rows;
console.log(users.map((r) => `${r.email}=${r.d}`).join('  '));
const events = (await db.query(`SELECT type, "sourceDept"::text s, "targetDept"::text t FROM "IntegrationEvent" ORDER BY type`)).rows;
console.log(events.map((r) => `${r.type}: ${r.s} -> ${r.t}`).join('  '));
console.log('Department enum now:', (await db.query(`SELECT enum_range(NULL::"Department")::text r`)).rows[0].r);
await db.close();

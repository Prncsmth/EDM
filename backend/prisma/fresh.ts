// Start clean for REAL data.
//
//   npm run db:fresh              → removes all sample/transaction data, keeps
//                                   users, DQ rules, species, storage units and trucks
//   npm run db:fresh -- --all     → also removes species, storage units and trucks
//
// ⚠ This empties the shared database for everyone using it.

import { rawPrisma } from '../src/db';
import { RULE_CATALOG } from '../src/dq/catalog';

const all = process.argv.includes('--all');

const TRANSACTIONS = [
  'AuditLog', 'IntegrationEvent', 'DqIssue', 'DqScore',
  'Payment', 'InvoiceItem', 'Invoice', 'FisherSettlement',
  'DispatchItem', 'Dispatch', 'SalesOrderItem', 'SalesOrder',
  'TemperatureLog', 'Lot', 'LandingItem', 'Landing',
  'Vessel', 'Fisher', 'Buyer',
];
const SETUP = ['Species', 'StorageUnit', 'Truck'];

async function main() {
  const tables = all ? [...TRANSACTIONS, ...SETUP] : TRANSACTIONS;
  await rawPrisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"public"."${t}"`).join(', ')} RESTART IDENTITY CASCADE`);

  // Make sure the 15 rules exist (keeps any changes the admin made to them).
  for (const r of RULE_CATALOG) {
    await rawPrisma.dqRule.upsert({ where: { code: r.code }, update: {}, create: { ...r, params: r.params ?? {} } });
  }

  const users = await rawPrisma.user.count();
  console.log(`Done. Cleared: ${tables.join(', ')}`);
  console.log(`Kept: ${users} user account(s), ${RULE_CATALOG.length} DQ rules${all ? '' : ', species, storage units, trucks'}.`);
  if (!users) console.log('⚠ No users exist — run "npm run db:seed" first to create the accounts.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => rawPrisma.$disconnect());

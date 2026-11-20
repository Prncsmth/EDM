// Demo data for the LAOT Seafood Trading Corporation system.
//
// ⚠ Running this ERASES all data and loads fresh demo data.
//
// Clean transactions are created through the real department services, so the
// integration events, settlements, dispatches and invoices are all genuine.
// Some records are inserted directly to simulate "legacy" dirty data that was
// encoded before the DQM rules existed — the DQM module should find all of them.

import bcrypt from 'bcryptjs';
import { prisma, rawPrisma } from '../src/db';
import { requestContext } from '../src/context';
import { RULE_CATALOG } from '../src/dq/catalog';
import { registerIntegrationHandlers } from '../src/integration/handlers';
import { createLanding, gradeLandingItem } from '../src/services/portOps';
import { storeLot } from '../src/services/warehouse';
import { createOrder } from '../src/services/sales';
import { departDispatch, deliverDispatch } from '../src/services/logistics';
import { approveSettlement, paySettlement, recordPayment } from '../src/services/finance';
import { runFullScan } from '../src/dq/scan';

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);
const PASSWORD = 'laot2026';

async function wipe() {
  const tables = await rawPrisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  if (list) await rawPrisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

async function main() {
  console.log('Clearing old data…');
  await wipe();
  registerIntegrationHandlers();

  // ───────── Data quality rules ─────────
  for (const r of RULE_CATALOG) {
    await rawPrisma.dqRule.create({ data: { ...r, params: r.params ?? {} } });
  }

  // ───────── Users (one per department) ─────────
  const hash = await bcrypt.hash(PASSWORD, 10);
  const users = [
    ['Vience', 'admin@laot.com', 'ADMIN'],
    ['Jameboy', 'operations@laot.com', 'OPERATIONS'],
    ['Jessie', 'sales@laot.com', 'SALES'],
    ['Carl Ian', 'finance@laot.com', 'FINANCE'],
  ] as const;
  for (const [name, email, department] of users) await rawPrisma.user.create({ data: { name, email, department, passwordHash: hash } });
  const admin = (await rawPrisma.user.findUnique({ where: { email: 'admin@laot.com' } }))!;

  await requestContext.run({ user: { id: admin.id, name: admin.name, email: admin.email, department: 'ADMIN' } }, async () => {
    // ───────── Species ─────────
    const species = async (name: string, localName: string, buy: number, min: number, max: number, shelf: number, shrink: number, tMin: number, tMax: number) =>
      prisma.species.create({
        data: { name, localName, buyingPricePerKg: buy, minSellPricePerKg: min, maxSellPricePerKg: max, maxShelfHours: shelf, shrinkageTolerancePct: shrink, minTempC: tMin, maxTempC: tMax },
      });
    const tuna = await species('Yellowfin Tuna', 'Bariles', 220, 300, 450, 240, 3, -25, -18);
    const skipjack = await species('Skipjack Tuna', 'Gulyasan', 110, 140, 220, 168, 3, -25, -18);
    const scad = await species('Round Scad', 'Galunggong', 90, 120, 180, 72, 4, 0, 4);
    const grouper = await species('Grouper', 'Lapu-Lapu', 380, 450, 650, 72, 2.5, 0, 4);
    const squid = await species('Squid', 'Pusit', 200, 260, 380, 48, 5, 0, 4);
    const marlin = await species('Blue Marlin', 'Malasugi', 260, 330, 480, 168, 3, -25, -18);

    // ───────── Fishers (some dirty on purpose) ─────────
    const fisher = (data: any) => rawPrisma.fisher.create({ data }); // raw = legacy data, no cleansing / DQ
    const juan = await fisher({ name: 'Juan Dela Cruz', phone: '09171234567', tin: '123-456-789-000', payoutMethod: 'GCASH', payoutAccount: '09171234567', address: 'Purok 3, Barangay Daliao, Toril' });
    const juanDup = await fisher({ name: 'dela cruz, juan', phone: '+63 917 123 4567', address: 'Daliao,  Toril' }); // duplicate + bad format
    const pedro = await fisher({ name: 'Pedro Santos', phone: '09181112222', tin: '234-567-890-000', payoutMethod: 'BANK', payoutAccount: 'BDO 0012-3456-7890' });
    const maria = await fisher({ name: 'Maria Clara Reyes', phone: '0920-555-1234', tin: '987654321000', payoutMethod: 'CASH' }); // dirty formats
    const ramon = await fisher({ name: 'Ramon Villanueva', phone: '09225557777' }); // no TIN / payout → DQ-01
    const antonio = await fisher({ name: 'Antonio Bautista', phone: '09195553333', tin: '345-678-901-000', payoutMethod: 'GCASH', payoutAccount: '09195553333' });
    await fisher({ name: '  benjie   ALCANTARA ', phone: '0917-12', payoutMethod: 'CASH' }); // messy name + invalid phone

    // ───────── Vessels ─────────
    const vessel = (registrationNo: string, name: string, ownerId: number, capacityKg: number) =>
      prisma.vessel.create({ data: { registrationNo, name, ownerId, capacityKg } });
    const barilesKing = await vessel('MARINA-DVO-0012', 'FB BARILES KING', juan.id, 3000);
    await vessel('MARINA-DVO-0045', 'FB DAGAT BULAWAN', pedro.id, 2000);
    const santaMaria = await vessel('MARINA-DVO-0078', 'FB SANTA MARIA', maria.id, 1500);
    const bituon = await vessel('MARINA-DVO-0101', 'FB BITUON', ramon.id, 800);
    const luckyStar = await vessel('MARINA-DVO-0133', 'FB LUCKY STAR', antonio.id, 2500);
    const dagatnon = await vessel('MARINA-DVO-0150', 'FB DAGATNON', juanDup.id, 1000); // owned by the duplicate record

    // ───────── Buyers ─────────
    const buyer = (data: any) => rawPrisma.buyer.create({ data });
    const mindanao = await buyer({ businessName: 'Mindanao Seafoods Inc.', contactPerson: 'Rosa Lim', phone: '09173334444', email: 'purchasing@mindanaoseafoods.ph', tin: '456-789-012-000', creditLimit: 500000 });
    await buyer({ businessName: 'Mindanao Sea Foods Inc', contactPerson: 'rosa lim', phone: '+63 917 333 4444', creditLimit: 0 }); // duplicate
    const seaBreeze = await buyer({ businessName: 'Sea Breeze Restaurant Group', contactPerson: 'Paolo Tan', phone: '09189990000', email: 'orders@seabreeze', tin: '567-890-123-000', creditLimit: 200000 }); // bad email
    await buyer({ businessName: 'Bankerohan Fish Dealers Assoc.', contactPerson: 'Nestor Go', phone: '09201112233', tin: '678-901-234-000', creditLimit: 150000 });
    await buyer({ businessName: "Lola Nena's Kinilaw House", contactPerson: 'Nena Abad', phone: '082-234-5678', creditLimit: 30000 }); // landline, invalid mobile format

    // ───────── Storage & trucks ─────────
    const bf1 = await prisma.storageUnit.create({ data: { code: 'BF-01', type: 'BLAST_FREEZER', capacityKg: 10000, minTempC: -30, maxTempC: -18 } });
    const bf2 = await prisma.storageUnit.create({ data: { code: 'BF-02', type: 'BLAST_FREEZER', capacityKg: 8000, minTempC: -30, maxTempC: -18 } });
    const ch1 = await prisma.storageUnit.create({ data: { code: 'CH-01', type: 'CHILLER', capacityKg: 5000, minTempC: 0, maxTempC: 4 } });
    const ch2 = await prisma.storageUnit.create({ data: { code: 'CH-02', type: 'CHILLER', capacityKg: 3000, minTempC: 0, maxTempC: 4 } });
    const truckSmall = await prisma.truck.create({ data: { plateNo: 'LAB-1234', capacityKg: 3000, isReefer: true } });
    await prisma.truck.create({ data: { plateNo: 'LAC-5678', capacityKg: 5000, isReefer: true } });
    await prisma.truck.create({ data: { plateNo: 'NBD-9012', capacityKg: 4000, isReefer: false } });

    // ───────── Temperature logs (last 24 h) ─────────
    const logs: { storageUnitId: number; readingC: number; recordedAt: Date }[] = [];
    for (let h = 24; h >= 1; h -= 2) {
      logs.push({ storageUnitId: bf1.id, readingC: -22 + Math.round(Math.sin(h) * 10) / 10, recordedAt: hoursAgo(h) });
      logs.push({ storageUnitId: bf2.id, readingC: -21 + Math.round(Math.cos(h) * 10) / 10, recordedAt: hoursAgo(h + 0.5) });
      logs.push({ storageUnitId: ch1.id, readingC: 2 + Math.round(Math.sin(h) * 10) / 10, recordedAt: hoursAgo(h) });
      if (h >= 7) logs.push({ storageUnitId: ch2.id, readingC: 1.5 + Math.round(Math.cos(h) * 10) / 10, recordedAt: hoursAgo(h) }); // CH-02: no reading for 6 h → DQ-14
    }
    logs.push({ storageUnitId: bf2.id, readingC: 25, recordedAt: hoursAgo(0.3) }); // impossible reading → DQ-04 + DQ-12
    await rawPrisma.temperatureLog.createMany({ data: logs });

    // ───────── Landing A: clean full cycle (30 h ago) ─────────
    const a = await createLanding({
      vesselId: barilesKing.id, arrivedAt: hoursAgo(30), notes: 'Night trip, Davao Gulf',
      items: [{ speciesId: tuna.id, grossWeightKg: 1200 }, { speciesId: skipjack.id, grossWeightKg: 800 }],
    });
    const aTuna = a.landing.items.find((i) => i.speciesId === tuna.id)!;
    const aSkip = a.landing.items.find((i) => i.speciesId === skipjack.id)!;
    const tunaLots = (await gradeLandingItem(aTuna.id, [{ grade: 'A', netWeightKg: 700 }, { grade: 'B', netWeightKg: 450 }])).lots;
    const skipLots = (await gradeLandingItem(aSkip.id, [{ grade: 'A', netWeightKg: 500 }, { grade: 'B', netWeightKg: 280 }])).lots;
    for (const l of tunaLots) await storeLot(l.id, bf1.id);
    for (const l of skipLots) await storeLot(l.id, bf2.id);
    const stlA = await rawPrisma.fisherSettlement.findUniqueOrThrow({ where: { landingId: a.landing.id } });
    await approveSettlement(stlA.id);
    await paySettlement(stlA.id);

    // Order 1: delivered, one item lost too much weight (DQ-10), invoice partly paid
    const o1 = await createOrder(mindanao.id, [
      { lotId: tunaLots[0].id, weightKg: 300, pricePerKg: 380 },
      { lotId: skipLots[0].id, weightKg: 200, pricePerKg: 180 },
    ]);
    const d1 = await rawPrisma.dispatch.findUniqueOrThrow({ where: { salesOrderId: o1.order.id }, include: { items: true } });
    await departDispatch(d1.id, truckSmall.id);
    await deliverDispatch(d1.id, [
      { itemId: d1.items[0].id, weightOutKg: 296 },
      { itemId: d1.items[1].id, weightOutKg: 186 }, // 7% shrinkage
    ]);
    const inv1 = await rawPrisma.invoice.findUniqueOrThrow({ where: { salesOrderId: o1.order.id } });
    await recordPayment(inv1.id, { amount: 80000, method: 'Bank transfer', reference: 'BDO-778812' });
    // Legacy tampering: someone edited the invoice total by hand → DQ-11
    await rawPrisma.invoice.update({ where: { id: inv1.id }, data: { total: Number(inv1.total) + 500 } });

    // Order 2: confirmed, price above the allowed range (DQ-06), waiting for a truck
    await createOrder(seaBreeze.id, [{ lotId: tunaLots[1].id, weightKg: 150, pricePerKg: 520 }]);

    // ───────── Landing B: graded & stored, settlement waiting (10 h ago) ─────────
    const b = await createLanding({
      vesselId: santaMaria.id, arrivedAt: hoursAgo(10),
      items: [{ speciesId: grouper.id, grossWeightKg: 300 }, { speciesId: scad.id, grossWeightKg: 900 }],
    });
    const bGrouper = (await gradeLandingItem(b.landing.items.find((i) => i.speciesId === grouper.id)!.id, [{ grade: 'A', netWeightKg: 280 }])).lots;
    const bScad = (await gradeLandingItem(b.landing.items.find((i) => i.speciesId === scad.id)!.id, [{ grade: 'B', netWeightKg: 860 }])).lots;
    await storeLot(bGrouper[0].id, ch1.id);
    await storeLot(bScad[0].id, ch2.id);

    // ───────── Landing C: squid that is now past its 48 h limit (60 h ago) ─────────
    const c = await createLanding({ vesselId: bituon.id, arrivedAt: hoursAgo(60), items: [{ speciesId: squid.id, grossWeightKg: 400 }] });
    const cLots = (await gradeLandingItem(c.landing.items[0].id, [{ grade: 'A', netWeightKg: 380 }])).lots;
    // it was stored 2 days ago, when it was still fresh
    await rawPrisma.lot.update({ where: { id: cLots[0].id }, data: { status: 'IN_STORAGE', storageUnitId: ch1.id, storedAt: hoursAgo(58) } });
    // Ramon's settlement stays DRAFT: approving it is blocked by DQ-01 (no TIN / payout)

    // ───────── Landing D: arrived 5 h ago, not graded yet (DQ-15) ─────────
    await createLanding({
      vesselId: luckyStar.id, arrivedAt: hoursAgo(5),
      items: [{ speciesId: marlin.id, grossWeightKg: 600 }, { speciesId: tuna.id, grossWeightKg: 400 }],
    });

    // ───────── Landing E: more than the vessel can carry (DQ-07 warning) ─────────
    const e = await createLanding({ vesselId: dagatnon.id, arrivedAt: hoursAgo(20), items: [{ speciesId: scad.id, grossWeightKg: 1300 }] });
    const eLots = (await gradeLandingItem(e.landing.items[0].id, [{ grade: 'A', netWeightKg: 1250 }])).lots;
    await storeLot(eLots[0].id, ch2.id);
  });

  console.log('Running the first data quality scan…');
  const scan = await runFullScan();
  const overall = scan.scores.find((s) => s.scope === 'OVERALL');
  console.log(`Findings per rule: ${scan.rules.filter((r) => r.found).map((r) => `${r.code}=${r.found}`).join(', ')}`);
  console.log(`Lots quarantined: ${scan.quarantined}. Overall DQ score: ${overall?.score}%`);
  console.log(`\nDone. Log in with any of these (password: ${PASSWORD}):`);
  for (const [, email, dept] of users) console.log(`  ${dept.padEnd(10)} ${email}`);
}

main()
  .catch((e) => {
    console.error(e);
    throw e;
  })
  .finally(() => rawPrisma.$disconnect());

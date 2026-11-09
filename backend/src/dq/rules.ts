import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { PATTERNS } from '../lib/cleanse';

// ─────────────────────────────────────────────────────────────
// Rule implementations.
//
// check(): runs in REAL TIME at a "context" (a point in a workflow,
//          e.g. 'fisher.save'). Returns a problem message or null.
// scan():  runs in the BATCH scan over the whole database and returns
//          every record that currently breaks the rule.
// ─────────────────────────────────────────────────────────────

export type Finding = { entityType: string; entityId: number; entityLabel: string; message: string };
type Params = Record<string, any>;

export interface RuleImpl {
  contexts: string[];
  check?: (input: any, params: Params) => Promise<string | null> | string | null;
  scan?: (params: Params) => Promise<Finding[]>;
}

const num = (v: unknown) => Number(v ?? 0);
const kg = (v: number) => `${Math.round(v * 100) / 100} kg`;
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);

// ---------- shared helpers ----------

function contactProblems(rec: { phone?: string | null; tin?: string | null; email?: string | null }) {
  const problems: string[] = [];
  if (rec.phone && !PATTERNS.phone.test(rec.phone)) problems.push(`phone "${rec.phone}" is not 09XXXXXXXXX`);
  if (rec.tin && !PATTERNS.tin.test(rec.tin)) problems.push(`TIN "${rec.tin}" is not XXX-XXX-XXX-XXX`);
  if (rec.email && !PATTERNS.email.test(rec.email)) problems.push(`email "${rec.email}" is invalid`);
  return problems.length ? problems.join('; ') : null;
}

function fisherMissing(f: { tin?: string | null; payoutMethod?: string | null; payoutAccount?: string | null }) {
  const missing: string[] = [];
  if (!f.tin) missing.push('TIN');
  if (!f.payoutMethod) missing.push('payout method');
  if (f.payoutMethod && f.payoutMethod !== 'CASH' && !f.payoutAccount) missing.push('payout account');
  return missing;
}

/** Similar active records by name (pg_trgm) or by the same phone number (last 10 digits). */
export async function findSimilar(
  table: 'Fisher' | 'Buyer',
  name: string,
  phone: string | null | undefined,
  excludeId: number | null,
  threshold: number,
) {
  const nameCol = table === 'Fisher' ? Prisma.sql`"name"` : Prisma.sql`"businessName"`;
  const digits = (phone ?? '').replace(/\D/g, '').slice(-10) || '__none__';
  return prisma.$queryRaw<{ id: number; name: string; phone: string | null; sim: number }[]>`
    SELECT id, ${nameCol} AS name, phone, similarity(${nameCol}, ${name})::float AS sim
    FROM ${Prisma.raw(`"${table}"`)}
    WHERE status = 'ACTIVE'
      AND id <> ${excludeId ?? -1}
      AND (similarity(${nameCol}, ${name}) >= ${threshold}
           OR right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 10) = ${digits})
    ORDER BY sim DESC
    LIMIT 3`;
}

async function duplicatePairs(table: 'Fisher' | 'Buyer', threshold: number) {
  const nameCol = table === 'Fisher' ? `"name"` : `"businessName"`;
  return prisma.$queryRawUnsafe<{ a_id: number; a_name: string; b_id: number; b_name: string; sim: number; same_phone: boolean }[]>(
    `SELECT a.id a_id, a.${nameCol} a_name, b.id b_id, b.${nameCol} b_name,
            similarity(a.${nameCol}, b.${nameCol})::float sim,
            (a.phone IS NOT NULL AND b.phone IS NOT NULL AND
             right(regexp_replace(a.phone, '\\D', '', 'g'), 10) = right(regexp_replace(b.phone, '\\D', '', 'g'), 10)) same_phone
     FROM "${table}" a JOIN "${table}" b ON a.id < b.id
     WHERE a.status = 'ACTIVE' AND b.status = 'ACTIVE'
       AND (similarity(a.${nameCol}, b.${nameCol}) >= $1
            OR (a.phone IS NOT NULL AND b.phone IS NOT NULL AND
                right(regexp_replace(a.phone, '\\D', '', 'g'), 10) = right(regexp_replace(b.phone, '\\D', '', 'g'), 10)))
     ORDER BY sim DESC`,
    threshold,
  );
}

export const getDuplicatePairs = duplicatePairs;

// ---------- the rules ----------

export const RULES: Record<string, RuleImpl> = {
  // DQ-01 Completeness — fisher payout details
  'DQ-01': {
    contexts: ['settlement.approve'],
    check: ({ fisher }) => {
      const missing = fisherMissing(fisher);
      return missing.length ? `Fisher ${fisher.name} is missing ${missing.join(', ')}` : null;
    },
    scan: async () => {
      const fishers = await prisma.fisher.findMany({ where: { status: 'ACTIVE' } });
      return fishers
        .map((f) => ({ f, missing: fisherMissing(f) }))
        .filter((x) => x.missing.length)
        .map(({ f, missing }) => ({ entityType: 'Fisher', entityId: f.id, entityLabel: f.name, message: `Missing ${missing.join(', ')}` }));
    },
  },

  // DQ-02 Completeness — lot ready for storage
  'DQ-02': {
    contexts: ['lot.store'],
    check: ({ lot, storageUnitId }) => {
      const missing: string[] = [];
      if (!lot.grade) missing.push('grade');
      if (!(lot.netWeightKg > 0)) missing.push('net weight');
      if (!lot.expiresAt) missing.push('expiry time');
      if (!storageUnitId) missing.push('storage unit');
      return missing.length ? `Lot ${lot.lotNo} is missing ${missing.join(', ')}` : null;
    },
    scan: async () => {
      const lots = await prisma.lot.findMany({
        where: { status: { in: ['IN_STORAGE', 'RESERVED'] }, OR: [{ storageUnitId: null }, { netWeightKg: { lte: 0 } }] },
      });
      return lots.map((l) => ({
        entityType: 'Lot', entityId: l.id, entityLabel: l.lotNo,
        message: l.storageUnitId ? 'Net weight is zero' : 'In storage but no storage unit recorded',
      }));
    },
  },

  // DQ-03 Validity — phone / TIN / email format
  'DQ-03': {
    contexts: ['fisher.save', 'buyer.save'],
    check: ({ data }) => contactProblems(data),
    scan: async () => {
      const [fishers, buyers] = await Promise.all([
        prisma.fisher.findMany({ where: { status: 'ACTIVE' } }),
        prisma.buyer.findMany({ where: { status: 'ACTIVE' } }),
      ]);
      const out: Finding[] = [];
      for (const f of fishers) {
        const p = contactProblems(f);
        if (p) out.push({ entityType: 'Fisher', entityId: f.id, entityLabel: f.name, message: p });
      }
      for (const b of buyers) {
        const p = contactProblems(b);
        if (p) out.push({ entityType: 'Buyer', entityId: b.id, entityLabel: b.businessName, message: p });
      }
      return out;
    },
  },

  // DQ-04 Validity — physically plausible temperature
  'DQ-04': {
    contexts: ['temp.save'],
    check: ({ readingC }, p) =>
      readingC < p.minC || readingC > p.maxC ? `Reading ${readingC}°C is outside ${p.minC}°C to ${p.maxC}°C — likely a sensor or encoding error` : null,
    scan: async (p) => {
      const logs = await prisma.temperatureLog.findMany({
        where: { recordedAt: { gte: hoursAgo(24 * 7) }, OR: [{ readingC: { lt: p.minC } }, { readingC: { gt: p.maxC } }] },
        include: { storageUnit: true },
      });
      return logs.map((l) => ({
        entityType: 'TemperatureLog', entityId: l.id, entityLabel: `${l.storageUnit.code} @ ${l.recordedAt.toISOString().slice(0, 16).replace('T', ' ')}`,
        message: `Reading ${l.readingC}°C is outside ${p.minC}°C to ${p.maxC}°C`,
      }));
    },
  },

  // DQ-05 Accuracy — net ≤ gross
  'DQ-05': {
    contexts: ['lot.grade'],
    check: ({ grossWeightKg, totalNetKg }) =>
      totalNetKg > grossWeightKg + 0.001 ? `Total net weight ${kg(totalNetKg)} exceeds the gross weight received (${kg(grossWeightKg)})` : null,
    scan: async () => {
      const items = await prisma.landingItem.findMany({ include: { lots: true, species: true, landing: true } });
      return items
        .map((i) => ({ i, net: i.lots.reduce((s, l) => s + l.netWeightKg, 0) }))
        .filter(({ i, net }) => net > i.grossWeightKg + 0.001)
        .map(({ i, net }) => ({
          entityType: 'LandingItem', entityId: i.id, entityLabel: `${i.landing.landingNo} · ${i.species.name}`,
          message: `Net ${kg(net)} > gross ${kg(i.grossWeightKg)}`,
        }));
    },
  },

  // DQ-06 Accuracy — selling price range
  'DQ-06': {
    contexts: ['order.confirm'],
    check: ({ species, pricePerKg }) => {
      const min = num(species.minSellPricePerKg), max = num(species.maxSellPricePerKg);
      return pricePerKg < min || pricePerKg > max ? `₱${pricePerKg}/kg for ${species.name} is outside ₱${min}–₱${max}/kg` : null;
    },
    scan: async () => {
      const items = await prisma.salesOrderItem.findMany({
        where: { salesOrder: { status: { not: 'CANCELLED' } } },
        include: { lot: { include: { species: true } }, salesOrder: true },
      });
      return items
        .filter((i) => num(i.pricePerKg) < num(i.lot.species.minSellPricePerKg) || num(i.pricePerKg) > num(i.lot.species.maxSellPricePerKg))
        .map((i) => ({
          entityType: 'SalesOrderItem', entityId: i.id, entityLabel: `${i.salesOrder.orderNo} · ${i.lot.lotNo}`,
          message: `₱${num(i.pricePerKg)}/kg is outside ₱${num(i.lot.species.minSellPricePerKg)}–₱${num(i.lot.species.maxSellPricePerKg)}/kg`,
        }));
    },
  },

  // DQ-07 Accuracy — vessel capacity
  'DQ-07': {
    contexts: ['landing.save'],
    check: ({ vessel, totalGrossKg }) =>
      totalGrossKg > vessel.capacityKg ? `Landed ${kg(totalGrossKg)} but vessel ${vessel.name} can only carry ${kg(vessel.capacityKg)}` : null,
    scan: async () => {
      const landings = await prisma.landing.findMany({ include: { items: true, vessel: true } });
      return landings
        .map((l) => ({ l, total: l.items.reduce((s, i) => s + i.grossWeightKg, 0) }))
        .filter(({ l, total }) => total > l.vessel.capacityKg)
        .map(({ l, total }) => ({
          entityType: 'Landing', entityId: l.id, entityLabel: l.landingNo,
          message: `Landed ${kg(total)} > capacity of ${l.vessel.name} (${kg(l.vessel.capacityKg)})`,
        }));
    },
  },

  // DQ-08 Uniqueness — duplicate fishers / buyers
  'DQ-08': {
    contexts: ['fisher.save', 'buyer.save'],
    check: async ({ table, name, phone, id }, p) => {
      if (!name) return null;
      const similar = await findSimilar(table, name, phone, id ?? null, p.threshold);
      if (!similar.length) return null;
      const s = similar[0];
      return `Possible duplicate of #${s.id} "${s.name}" (${Math.round(s.sim * 100)}% similar name${phone && s.phone && s.phone.replace(/\D/g, '').slice(-10) === phone.replace(/\D/g, '').slice(-10) ? ', same phone' : ''})`;
    },
    scan: async (p) => {
      const out: Finding[] = [];
      for (const table of ['Fisher', 'Buyer'] as const) {
        for (const pair of await duplicatePairs(table, p.threshold)) {
          // flag the newer record; it is usually the one that should be merged away
          out.push({
            entityType: table, entityId: pair.b_id, entityLabel: pair.b_name,
            message: `Possible duplicate of #${pair.a_id} "${pair.a_name}" (${Math.round(pair.sim * 100)}% similar${pair.same_phone ? ', same phone' : ''})`,
          });
        }
      }
      // one issue per record even if it matches several others
      return [...new Map(out.map((f) => [`${f.entityType}:${f.entityId}`, f])).values()];
    },
  },

  // DQ-09 Uniqueness — no over-selling
  'DQ-09': {
    contexts: ['order.confirm'],
    check: ({ lot, requestedKg }) => {
      const available = lot.netWeightKg - lot.reservedKg;
      return requestedKg > available + 0.001 ? `Lot ${lot.lotNo} only has ${kg(available)} available but ${kg(requestedKg)} was requested` : null;
    },
    scan: async () => {
      const lots = await prisma.lot.findMany();
      return lots
        .filter((l) => l.reservedKg > l.netWeightKg + 0.001)
        .map((l) => ({ entityType: 'Lot', entityId: l.id, entityLabel: l.lotNo, message: `Reserved ${kg(l.reservedKg)} > net ${kg(l.netWeightKg)} (over-sold)` }));
    },
  },

  // DQ-10 Consistency — shrinkage
  'DQ-10': {
    contexts: ['dispatch.deliver'],
    check: ({ orderedKg, weightOutKg, species }) => {
      const pct = ((orderedKg - weightOutKg) / orderedKg) * 100;
      return pct > species.shrinkageTolerancePct
        ? `Shrinkage ${pct.toFixed(1)}% (${kg(orderedKg)} → ${kg(weightOutKg)}) exceeds the ${species.shrinkageTolerancePct}% tolerance for ${species.name}`
        : null;
    },
    scan: async () => {
      const items = await prisma.dispatchItem.findMany({
        where: { weightOutKg: { not: null } },
        include: { lot: { include: { species: true } }, dispatch: true },
      });
      return items
        .map((i) => ({ i, pct: ((i.orderedKg - (i.weightOutKg ?? 0)) / i.orderedKg) * 100 }))
        .filter(({ i, pct }) => pct > i.lot.species.shrinkageTolerancePct)
        .map(({ i, pct }) => ({
          entityType: 'DispatchItem', entityId: i.id, entityLabel: `${i.dispatch.dispatchNo} · ${i.lot.lotNo}`,
          message: `Shrinkage ${pct.toFixed(1)}% exceeds ${i.lot.species.shrinkageTolerancePct}% (${kg(i.orderedKg)} → ${kg(i.weightOutKg ?? 0)})`,
        }));
    },
  },

  // DQ-11 Consistency — invoice total
  'DQ-11': {
    contexts: ['invoice.save'],
    check: ({ total, items }) => {
      const sum = items.reduce((s: number, i: any) => s + num(i.amount), 0);
      return Math.abs(sum - total) > 0.01 ? `Invoice total ₱${total.toFixed(2)} does not match the sum of items ₱${sum.toFixed(2)}` : null;
    },
    scan: async () => {
      const invoices = await prisma.invoice.findMany({ include: { items: true } });
      return invoices
        .map((inv) => ({ inv, sum: inv.items.reduce((s, i) => s + num(i.amount), 0) }))
        .filter(({ inv, sum }) => Math.abs(sum - num(inv.total)) > 0.01)
        .map(({ inv, sum }) => ({
          entityType: 'Invoice', entityId: inv.id, entityLabel: inv.invoiceNo,
          message: `Total ₱${num(inv.total).toFixed(2)} ≠ sum of items ₱${sum.toFixed(2)}`,
        }));
    },
  },

  // DQ-12 Consistency — unit temperature in range
  'DQ-12': {
    contexts: ['temp.save'],
    check: ({ unit, readingC }) =>
      readingC < unit.minTempC || readingC > unit.maxTempC ? `${unit.code} is at ${readingC}°C; required ${unit.minTempC}°C to ${unit.maxTempC}°C` : null,
    scan: async () => {
      const units = await prisma.storageUnit.findMany({ include: { temperatureLogs: { orderBy: { recordedAt: 'desc' }, take: 1 } } });
      return units
        .filter((u) => u.temperatureLogs[0] && (u.temperatureLogs[0].readingC < u.minTempC || u.temperatureLogs[0].readingC > u.maxTempC))
        .map((u) => ({
          entityType: 'StorageUnit', entityId: u.id, entityLabel: u.code,
          message: `Latest reading ${u.temperatureLogs[0].readingC}°C; required ${u.minTempC}°C to ${u.maxTempC}°C`,
        }));
    },
  },

  // DQ-13 Timeliness — expired lots (the scan also quarantines them; see scan.ts)
  'DQ-13': {
    contexts: ['order.confirm', 'lot.store'],
    check: ({ lot }) => (new Date(lot.expiresAt) < new Date() ? `Lot ${lot.lotNo} expired on ${new Date(lot.expiresAt).toLocaleString('en-PH')}` : null),
    scan: async () => {
      const lots = await prisma.lot.findMany({
        where: { expiresAt: { lt: new Date() }, status: { in: ['GRADED', 'IN_STORAGE', 'RESERVED', 'QUARANTINED'] } },
      });
      return lots.map((l) => ({
        entityType: 'Lot', entityId: l.id, entityLabel: l.lotNo,
        message: `Expired ${l.expiresAt.toLocaleString('en-PH')} — quarantined; mark as spoiled once disposed`,
      }));
    },
  },

  // DQ-14 Timeliness — temperature logged regularly
  'DQ-14': {
    contexts: [],
    scan: async (p) => {
      const units = await prisma.storageUnit.findMany({ include: { temperatureLogs: { orderBy: { recordedAt: 'desc' }, take: 1 } } });
      return units
        .filter((u) => !u.temperatureLogs[0] || u.temperatureLogs[0].recordedAt < hoursAgo(p.hours))
        .map((u) => ({
          entityType: 'StorageUnit', entityId: u.id, entityLabel: u.code,
          message: u.temperatureLogs[0]
            ? `No temperature reading since ${u.temperatureLogs[0].recordedAt.toLocaleString('en-PH')} (limit ${p.hours}h)`
            : 'No temperature reading recorded yet',
        }));
    },
  },

  // DQ-15 Timeliness — landings graded promptly
  'DQ-15': {
    contexts: [],
    scan: async (p) => {
      const landings = await prisma.landing.findMany({ where: { status: 'RECEIVED', arrivedAt: { lt: hoursAgo(p.hours) } }, include: { vessel: true } });
      return landings.map((l) => ({
        entityType: 'Landing', entityId: l.id, entityLabel: l.landingNo,
        message: `Arrived ${l.arrivedAt.toLocaleString('en-PH')} from ${l.vessel.name} and still not graded (limit ${p.hours}h)`,
      }));
    },
  },
};

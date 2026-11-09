import type { Department, DqDimension } from '@prisma/client';
import { prisma } from '../db';
import { publish } from '../integration/bus';
import { openIssue, ruleEntities } from './engine';
import { RULES } from './rules';

// ─────────────────────────────────────────────────────────────
// Batch scan: checks the WHOLE database against every active rule,
// syncs the issue queue, quarantines expired lots and saves today's scores.
// Runs on a schedule (jobs/scheduler.ts) and from the DQM dashboard.
// ─────────────────────────────────────────────────────────────

// The free hosting tier sleeps when idle, so the 15-minute schedule can be missed.
// scanIfStale() runs a scan on demand (e.g. when the DQ dashboard opens) if the last one is too old.
let lastScanAt = 0;
let scanning: Promise<unknown> | null = null;

export async function scanIfStale(maxAgeMinutes = 15) {
  if (Date.now() - lastScanAt < maxAgeMinutes * 60_000) return;
  scanning ??= runFullScan().finally(() => {
    scanning = null;
  });
  await scanning;
}

export async function runFullScan() {
  lastScanAt = Date.now();
  const started = Date.now();
  const quarantined = await quarantineExpiredLots();
  const rules = await prisma.dqRule.findMany({ where: { isActive: true }, orderBy: { code: 'asc' } });
  const perRule: { code: string; found: number; resolved: number }[] = [];

  for (const rule of rules) {
    const impl = RULES[rule.code];
    if (!impl?.scan) continue;
    const findings = await impl.scan(rule.params as any);

    for (const f of findings) await openIssue(rule, f.entityType, f.entityId, f.entityLabel, f.message);

    // Anything still open for this rule but no longer found has been fixed.
    const found = new Set(findings.map((f) => `${f.entityType}:${f.entityId}`));
    const open = await prisma.dqIssue.findMany({ where: { ruleId: rule.id, status: 'OPEN' } });
    const fixed = open.filter((i) => !found.has(`${i.entityType}:${i.entityId}`)).map((i) => i.id);
    if (fixed.length) {
      await prisma.dqIssue.updateMany({
        where: { id: { in: fixed } },
        data: { status: 'RESOLVED', resolvedAt: new Date(), note: 'Auto-resolved: no longer detected by scan' },
      });
    }
    perRule.push({ code: rule.code, found: findings.length, resolved: fixed.length });
  }

  const scores = await snapshotScores();
  return { durationMs: Date.now() - started, quarantined, rules: perRule, scores };
}

/** DQ-13: expired lots are pulled from sale automatically and both Warehouse and Sales are notified. */
async function quarantineExpiredLots() {
  const rule = await prisma.dqRule.findUnique({ where: { code: 'DQ-13' } });
  if (!rule?.isActive) return 0;
  const lots = await prisma.lot.findMany({
    where: { expiresAt: { lt: new Date() }, status: { in: ['GRADED', 'IN_STORAGE', 'RESERVED'] } },
  });
  for (const lot of lots) {
    await prisma.lot.update({ where: { id: lot.id }, data: { status: 'QUARANTINED' } });
    await publish({
      type: 'LotQuarantined', source: 'OPERATIONS', target: 'SALES', entityType: 'Lot', entityId: lot.id,
      message: `DQ-13: Lot ${lot.lotNo} passed its freshness limit and was quarantined (removed from sale)`,
    });
  }
  return lots.length;
}

// ---------- Scores ----------

const ENTITY_COUNTERS: Record<string, () => Promise<number>> = {
  Fisher: () => prisma.fisher.count({ where: { status: 'ACTIVE' } }),
  Buyer: () => prisma.buyer.count({ where: { status: 'ACTIVE' } }),
  Lot: () => prisma.lot.count(),
  Landing: () => prisma.landing.count(),
  LandingItem: () => prisma.landingItem.count(),
  TemperatureLog: () => prisma.temperatureLog.count({ where: { recordedAt: { gte: new Date(Date.now() - 7 * 86400_000) } } }),
  SalesOrderItem: () => prisma.salesOrderItem.count(),
  DispatchItem: () => prisma.dispatchItem.count({ where: { weightOutKg: { not: null } } }),
  Invoice: () => prisma.invoice.count(),
  StorageUnit: () => prisma.storageUnit.count(),
};

type ScoreRow = { scope: string; score: number; totalRecords: number; failingRecords: number };

/**
 * Score = % of checked records with no open issue.
 * Computed overall, per department (rules it owns) and per dimension.
 */
export async function computeScores(): Promise<ScoreRow[]> {
  const rules = await prisma.dqRule.findMany({ where: { isActive: true } });
  const openIssues = await prisma.dqIssue.findMany({ where: { status: 'OPEN' }, include: { rule: true } });
  const counts: Record<string, number> = {};
  for (const [type, counter] of Object.entries(ENTITY_COUNTERS)) counts[type] = await counter();

  const score = (scope: string, ruleFilter: (r: (typeof rules)[number]) => boolean): ScoreRow => {
    const scoped = rules.filter(ruleFilter);
    const entityTypes = new Set(scoped.flatMap(ruleEntities));
    const total = [...entityTypes].reduce((s, t) => s + (counts[t] ?? 0), 0);
    const ruleIds = new Set(scoped.map((r) => r.id));
    const failing = new Set(openIssues.filter((i) => ruleIds.has(i.ruleId)).map((i) => `${i.entityType}:${i.entityId}`)).size;
    const value = total === 0 ? 100 : Math.max(0, Math.round((1 - failing / total) * 1000) / 10);
    return { scope, score: value, totalRecords: total, failingRecords: failing };
  };

  const departments: Department[] = ['ADMIN', 'OPERATIONS', 'SALES', 'FINANCE'];
  const dimensions: DqDimension[] = ['COMPLETENESS', 'VALIDITY', 'ACCURACY', 'UNIQUENESS', 'CONSISTENCY', 'TIMELINESS'];
  return [
    score('OVERALL', () => true),
    ...departments.filter((d) => rules.some((r) => r.ownerDepartment === d)).map((d) => score(d, (r) => r.ownerDepartment === d)),
    ...dimensions.map((dim) => score(dim, (r) => r.dimension === dim)),
  ];
}

export async function snapshotScores() {
  const rows = await computeScores();
  const date = new Date(new Date().toISOString().slice(0, 10));
  for (const row of rows) {
    await prisma.dqScore.upsert({
      where: { date_scope: { date, scope: row.scope } },
      update: { score: row.score, totalRecords: row.totalRecords, failingRecords: row.failingRecords },
      create: { date, ...row },
    });
  }
  return rows;
}

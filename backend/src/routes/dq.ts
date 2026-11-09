import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { allow } from '../middleware/auth';
import { badRequest, notFound } from '../lib/errors';
import { idParam, optText } from '../lib/validation';
import { cleanBuyer, cleanFisher } from '../lib/cleanse';
import { computeScores, runFullScan, scanIfStale } from '../dq/scan';
import { getDuplicatePairs } from '../dq/rules';
import { currentUser } from '../context';

// ───────── Data Quality Management API ─────────
export const dqRouter = Router();

dqRouter.get('/dq/summary', async (_req, res) => {
  await scanIfStale(); // keeps results fresh even if the server slept through its schedule
  const [scores, history, openByRule, openByDept, recent, lastScan] = await Promise.all([
    computeScores(),
    prisma.dqScore.findMany({ orderBy: { date: 'asc' }, where: { date: { gte: new Date(Date.now() - 30 * 86400_000) } } }),
    prisma.dqIssue.groupBy({ by: ['ruleId'], where: { status: 'OPEN' }, _count: { _all: true } }),
    prisma.dqIssue.groupBy({ by: ['department', 'severity'], where: { status: 'OPEN' }, _count: { _all: true } }),
    prisma.dqIssue.findMany({ where: { status: 'OPEN' }, include: { rule: true }, orderBy: { detectedAt: 'desc' }, take: 8 }),
    prisma.dqScore.findFirst({ orderBy: { createdAt: 'desc' } }),
  ]);
  const rules = await prisma.dqRule.findMany();
  const ruleById = new Map(rules.map((r) => [r.id, r]));
  res.json({
    scores,
    history,
    topRules: openByRule
      .map((g) => ({ code: ruleById.get(g.ruleId)?.code, name: ruleById.get(g.ruleId)?.name, open: g._count._all }))
      .sort((a, b) => b.open - a.open)
      .slice(0, 5),
    openByDepartment: openByDept.map((g) => ({ department: g.department, severity: g.severity, open: g._count._all })),
    recent,
    lastScanAt: lastScan?.createdAt ?? null,
  });
});

dqRouter.post('/dq/scan', allow('ADMIN'), async (_req, res) => {
  res.json(await runFullScan());
});

// ───────── Rules ─────────

dqRouter.get('/dq/rules', async (_req, res) => {
  const [rules, counts] = await Promise.all([
    prisma.dqRule.findMany({ orderBy: { code: 'asc' } }),
    prisma.dqIssue.groupBy({ by: ['ruleId'], where: { status: 'OPEN' }, _count: { _all: true } }),
  ]);
  const open = new Map(counts.map((c) => [c.ruleId, c._count._all]));
  res.json(rules.map((r) => ({ ...r, openIssues: open.get(r.id) ?? 0 })));
});

dqRouter.patch('/dq/rules/:id', allow('ADMIN'), async (req, res) => {
  const ruleId = idParam(req.params.id);
  const rule = await prisma.dqRule.findUnique({ where: { id: ruleId } });
  if (!rule) throw notFound('Rule');
  const body = z.object({
    severity: z.enum(['BLOCK', 'WARN']).optional(),
    isActive: z.boolean().optional(),
    params: z.record(z.string(), z.coerce.number()).optional(),
  }).parse(req.body);
  if (body.params) {
    const allowed = Object.keys(rule.params as object);
    const unknown = Object.keys(body.params).filter((k) => !allowed.includes(k));
    if (unknown.length) throw badRequest(`Unknown parameter(s): ${unknown.join(', ')}`);
  }
  res.json(await prisma.dqRule.update({ where: { id: ruleId }, data: body }));
});

// ───────── Issues queue ─────────

dqRouter.get('/dq/issues', async (req, res) => {
  const where: any = {};
  where.status = req.query.status ? String(req.query.status) : 'OPEN';
  if (where.status === 'ALL') delete where.status;
  if (req.query.department) where.department = String(req.query.department);
  // Departments only see issues on data they own; the admin (data steward) sees all.
  const viewer = currentUser()!;
  if (viewer.department !== 'ADMIN') where.department = viewer.department;
  if (req.query.dimension) where.rule = { dimension: String(req.query.dimension) };
  if (req.query.ruleCode) where.rule = { ...(where.rule ?? {}), code: String(req.query.ruleCode) };
  if (req.query.severity) where.severity = String(req.query.severity);
  res.json(
    await prisma.dqIssue.findMany({
      where,
      include: { rule: true, resolvedBy: { select: { name: true } } },
      orderBy: [{ severity: 'asc' }, { detectedAt: 'desc' }],
      take: 500,
    }),
  );
});

dqRouter.patch('/dq/issues/:id', async (req, res) => {
  const issueId = idParam(req.params.id);
  const issue = await prisma.dqIssue.findUnique({ where: { id: issueId } });
  if (!issue) throw notFound('Issue');
  const user = currentUser()!;
  if (user.department !== 'ADMIN' && user.department !== issue.department) {
    throw badRequest(`Only ${issue.department} (the data owner) or ADMIN can update this issue`);
  }
  const body = z.object({ status: z.enum(['OPEN', 'RESOLVED', 'IGNORED']), note: optText }).parse(req.body);
  res.json(
    await prisma.dqIssue.update({
      where: { id: issueId },
      data: {
        status: body.status,
        note: body.note,
        resolvedAt: body.status === 'OPEN' ? null : new Date(),
        resolvedById: body.status === 'OPEN' ? null : user.id,
      },
    }),
  );
});

// ───────── Duplicates (DQ-08) ─────────

dqRouter.get('/dq/duplicates', allow('ADMIN'), async (req, res) => {
  const rule = await prisma.dqRule.findUnique({ where: { code: 'DQ-08' } });
  const threshold = Number((rule?.params as any)?.threshold ?? 0.6);
  const entity = req.query.entity === 'buyer' ? 'Buyer' : 'Fisher';
  const pairs = await getDuplicatePairs(entity, threshold);
  const ids = [...new Set(pairs.flatMap((p) => [p.a_id, p.b_id]))];
  const rows =
    entity === 'Fisher'
      ? await prisma.fisher.findMany({ where: { id: { in: ids } }, include: { _count: { select: { vessels: true, settlements: true } } } })
      : await prisma.buyer.findMany({ where: { id: { in: ids } }, include: { _count: { select: { salesOrders: true, invoices: true } } } });
  const byId = new Map(rows.map((r: any) => [r.id, r]));
  res.json(pairs.map((p) => ({ similarity: p.sim, samePhone: p.same_phone, a: byId.get(p.a_id), b: byId.get(p.b_id) })));
});

// ───────── Standardization (cleansing of existing records) ─────────

type Change = { entity: 'Fisher' | 'Buyer'; id: number; label: string; field: string; before: any; after: any };

async function pendingCleansing(): Promise<Change[]> {
  const changes: Change[] = [];
  const diff = (entity: Change['entity'], row: any, cleaned: any, label: string) => {
    for (const field of Object.keys(cleaned)) {
      if (cleaned[field] !== row[field] && !(cleaned[field] == null && row[field] == null)) {
        changes.push({ entity, id: row.id, label, field, before: row[field], after: cleaned[field] });
      }
    }
  };
  for (const f of await prisma.fisher.findMany({ where: { status: 'ACTIVE' } })) {
    const subset = { name: f.name, phone: f.phone, tin: f.tin, address: f.address, payoutAccount: f.payoutAccount };
    diff('Fisher', f, cleanFisher(subset), f.name);
  }
  for (const b of await prisma.buyer.findMany({ where: { status: 'ACTIVE' } })) {
    const subset = { businessName: b.businessName, contactPerson: b.contactPerson, phone: b.phone, email: b.email, tin: b.tin, address: b.address };
    diff('Buyer', b, cleanBuyer(subset), b.businessName);
  }
  return changes;
}

dqRouter.get('/dq/cleansing', allow('ADMIN'), async (_req, res) => {
  res.json(await pendingCleansing());
});

dqRouter.post('/dq/cleansing/apply', allow('ADMIN'), async (_req, res) => {
  const changes = await pendingCleansing();
  const grouped = new Map<string, { entity: Change['entity']; id: number; data: Record<string, any> }>();
  for (const c of changes) {
    const key = `${c.entity}:${c.id}`;
    const g = grouped.get(key) ?? { entity: c.entity, id: c.id, data: {} };
    g.data[c.field] = c.after;
    grouped.set(key, g);
  }
  for (const g of grouped.values()) {
    if (g.entity === 'Fisher') await prisma.fisher.update({ where: { id: g.id }, data: g.data });
    else await prisma.buyer.update({ where: { id: g.id }, data: g.data });
  }
  const scan = await runFullScan(); // re-check: formats that were fixed resolve their DQ-03 issues
  res.json({ recordsUpdated: grouped.size, fieldsChanged: changes.length, scan });
});

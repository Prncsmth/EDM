import type { DqRule } from '@prisma/client';
import { prisma } from '../db';
import { currentUser } from '../context';
import { HttpError } from '../lib/errors';
import { RULES } from './rules';

// ─────────────────────────────────────────────────────────────
// Real-time Data Quality gate.
//
//   const dq = await validate('fisher.save', input)   // throws if a BLOCK rule fails
//   ...save the record...
//   await record(dq, { Fisher: { id, label } })        // opens/resolves issues
// ─────────────────────────────────────────────────────────────

export type Violation = { code: string; name: string; severity: 'BLOCK' | 'WARN'; message: string };
export type DqResult = { context: string; warnings: (Violation & { rule: DqRule })[]; passed: DqRule[] };
export type Subject = { id: number; label: string };

/** Thrown when a BLOCK rule fails. The API returns it as HTTP 422 with the list of violations. */
export class DqBlockedError extends HttpError {
  constructor(public violations: Violation[]) {
    super(422, `Blocked by data quality rule${violations.length > 1 ? 's' : ''}: ${violations.map((v) => v.code).join(', ')}`, { violations });
  }
}

export const ruleEntities = (rule: Pick<DqRule, 'entityType'>) => rule.entityType.split(',').map((s) => s.trim());

async function activeRulesFor(context: string) {
  const codes = Object.entries(RULES)
    .filter(([, impl]) => impl.contexts.includes(context))
    .map(([code]) => code);
  if (!codes.length) return [];
  return prisma.dqRule.findMany({ where: { code: { in: codes }, isActive: true }, orderBy: { code: 'asc' } });
}

/** Runs every active rule for this context. BLOCK failures throw; WARN failures are returned. */
export async function validate(context: string, input: any): Promise<DqResult> {
  const rules = await activeRulesFor(context);
  const blocks: Violation[] = [];
  const result: DqResult = { context, warnings: [], passed: [] };

  for (const rule of rules) {
    const message = await RULES[rule.code].check?.(input, rule.params as any);
    if (!message) {
      result.passed.push(rule);
      continue;
    }
    const v: Violation = { code: rule.code, name: rule.name, severity: rule.severity, message };
    if (rule.severity === 'BLOCK') blocks.push(v);
    else result.warnings.push({ ...v, rule });
  }
  if (blocks.length) throw new DqBlockedError([...blocks, ...result.warnings.map(({ rule, ...w }) => w)]);
  return result;
}

/** Validate several inputs (e.g. every line of an order) and collect all BLOCK failures in one error. */
export async function validateAll(context: string, inputs: any[]) {
  const results: DqResult[] = [];
  const blocks: Violation[] = [];
  for (const input of inputs) {
    try {
      results.push(await validate(context, input));
    } catch (e) {
      if (e instanceof DqBlockedError) blocks.push(...e.violations.filter((v) => v.severity === 'BLOCK'));
      else throw e;
    }
  }
  if (blocks.length) throw new DqBlockedError(blocks);
  return results;
}

/**
 * After the record is saved: open an issue for each warning and auto-resolve
 * earlier issues of rules that now pass. `subjects` maps an entity type to the
 * saved record, e.g. { TemperatureLog: {...}, StorageUnit: {...} }.
 */
export async function record(result: DqResult, subjects: Record<string, Subject>) {
  const pick = (rule: DqRule) => {
    for (const type of ruleEntities(rule)) if (subjects[type]) return { type, subject: subjects[type] };
    return null;
  };

  for (const w of result.warnings) {
    const target = pick(w.rule);
    if (target) await openIssue(w.rule, target.type, target.subject.id, target.subject.label, w.message);
  }
  for (const rule of result.passed) {
    const target = pick(rule);
    if (target) await resolveIssues(rule.id, target.type, target.subject.id, 'Auto-resolved: passed on save');
  }
  return result.warnings.map(({ rule, ...w }) => w);
}

export async function openIssue(rule: DqRule, entityType: string, entityId: number, entityLabel: string, message: string) {
  const existing = await prisma.dqIssue.findFirst({
    where: { ruleId: rule.id, entityType, entityId, status: { in: ['OPEN', 'IGNORED'] } },
  });
  if (existing?.status === 'IGNORED') return existing; // a steward decided this is acceptable
  if (existing) {
    return prisma.dqIssue.update({ where: { id: existing.id }, data: { message, entityLabel, lastSeenAt: new Date() } });
  }
  return prisma.dqIssue.create({
    data: { ruleId: rule.id, entityType, entityId, entityLabel, message, severity: rule.severity, department: rule.ownerDepartment },
  });
}

export async function resolveIssues(ruleId: number, entityType: string, entityId: number, note: string) {
  await prisma.dqIssue.updateMany({
    where: { ruleId, entityType, entityId, status: 'OPEN' },
    data: { status: 'RESOLVED', resolvedAt: new Date(), resolvedById: currentUser()?.id, note },
  });
}

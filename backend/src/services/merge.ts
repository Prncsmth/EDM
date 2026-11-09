import { prisma, auditMerge } from '../db';
import { badRequest, notFound } from '../lib/errors';
import { currentUser } from '../context';

// ───────── DQM: merge duplicate master records ─────────
// The kept record "survives". Empty fields on it are filled from the duplicate,
// every transaction pointing to the duplicate is moved, and the duplicate is
// marked MERGED (never deleted, so history stays traceable).

const fillEmpty = (keep: any, dup: any, fields: string[]) => {
  const data: Record<string, any> = {};
  for (const f of fields) if ((keep[f] == null || keep[f] === '') && dup[f] != null && dup[f] !== '') data[f] = dup[f];
  return data;
};

async function closeIssues(entityType: string, ids: number[], note: string) {
  await prisma.dqIssue.updateMany({
    where: { entityType, entityId: { in: ids }, status: 'OPEN', rule: { code: { in: ['DQ-08'] } } },
    data: { status: 'RESOLVED', resolvedAt: new Date(), resolvedById: currentUser()?.id, note },
  });
}

export async function mergeFishers(duplicateId: number, keepId: number) {
  if (duplicateId === keepId) throw badRequest('Choose two different records');
  const [dup, keep] = await Promise.all([prisma.fisher.findUnique({ where: { id: duplicateId } }), prisma.fisher.findUnique({ where: { id: keepId } })]);
  if (!dup || !keep) throw notFound('Fisher');
  if (dup.status !== 'ACTIVE' || keep.status !== 'ACTIVE') throw badRequest('Both fishers must be ACTIVE');

  const filled = fillEmpty(keep, dup, ['phone', 'tin', 'address', 'payoutMethod', 'payoutAccount']);
  if (Object.keys(filled).length) await prisma.fisher.update({ where: { id: keepId }, data: filled });
  const vessels = await prisma.vessel.updateMany({ where: { ownerId: duplicateId }, data: { ownerId: keepId } });
  const settlements = await prisma.fisherSettlement.updateMany({ where: { fisherId: duplicateId }, data: { fisherId: keepId } });
  await prisma.fisher.update({ where: { id: duplicateId }, data: { status: 'MERGED', mergedIntoId: keepId } });

  // the duplicate no longer counts; its other open issues are closed as well
  await prisma.dqIssue.updateMany({
    where: { entityType: 'Fisher', entityId: duplicateId, status: 'OPEN' },
    data: { status: 'RESOLVED', resolvedAt: new Date(), resolvedById: currentUser()?.id, note: `Merged into #${keepId}` },
  });
  await closeIssues('Fisher', [keepId], `Duplicate #${duplicateId} merged into this record`);
  await auditMerge('Fisher', keepId, dup);
  return { kept: keepId, merged: duplicateId, filledFields: Object.keys(filled), moved: { vessels: vessels.count, settlements: settlements.count } };
}

export async function mergeBuyers(duplicateId: number, keepId: number) {
  if (duplicateId === keepId) throw badRequest('Choose two different records');
  const [dup, keep] = await Promise.all([prisma.buyer.findUnique({ where: { id: duplicateId } }), prisma.buyer.findUnique({ where: { id: keepId } })]);
  if (!dup || !keep) throw notFound('Buyer');
  if (dup.status !== 'ACTIVE' || keep.status !== 'ACTIVE') throw badRequest('Both buyers must be ACTIVE');

  const filled = fillEmpty(keep, dup, ['contactPerson', 'phone', 'email', 'tin', 'address']);
  if (Object.keys(filled).length) await prisma.buyer.update({ where: { id: keepId }, data: filled });
  const orders = await prisma.salesOrder.updateMany({ where: { buyerId: duplicateId }, data: { buyerId: keepId } });
  const invoices = await prisma.invoice.updateMany({ where: { buyerId: duplicateId }, data: { buyerId: keepId } });
  await prisma.buyer.update({ where: { id: duplicateId }, data: { status: 'MERGED', mergedIntoId: keepId } });

  await prisma.dqIssue.updateMany({
    where: { entityType: 'Buyer', entityId: duplicateId, status: 'OPEN' },
    data: { status: 'RESOLVED', resolvedAt: new Date(), resolvedById: currentUser()?.id, note: `Merged into #${keepId}` },
  });
  await closeIssues('Buyer', [keepId], `Duplicate #${duplicateId} merged into this record`);
  await auditMerge('Buyer', keepId, dup);
  return { kept: keepId, merged: duplicateId, filledFields: Object.keys(filled), moved: { orders: orders.count, invoices: invoices.count } };
}

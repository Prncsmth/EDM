import type { Grade } from '@prisma/client';
import { prisma } from '../db';
import { publish } from '../integration/bus';
import { validate, record } from '../dq/engine';
import { badRequest, notFound } from '../lib/errors';
import { nextNumber } from '../lib/numbering';
import { currentUser } from '../context';

// ───────── PORT OPERATIONS: a vessel arrives and its catch is weighed (gross) ─────────

export async function createLanding(input: {
  vesselId: number;
  arrivedAt?: Date;
  notes?: string;
  items: { speciesId: number; grossWeightKg: number }[];
}) {
  const vessel = await prisma.vessel.findUnique({ where: { id: input.vesselId }, include: { owner: true } });
  if (!vessel) throw notFound('Vessel');
  if (vessel.owner.status !== 'ACTIVE') throw badRequest(`Vessel owner ${vessel.owner.name} is not active (merged or inactive)`);

  const totalGrossKg = input.items.reduce((s, i) => s + i.grossWeightKg, 0);
  const dq = await validate('landing.save', { vessel, totalGrossKg });

  const landing = await prisma.landing.create({
    data: {
      landingNo: await nextNumber('LND'),
      vesselId: vessel.id,
      arrivedAt: input.arrivedAt ?? new Date(),
      notes: input.notes,
      receivedById: currentUser()?.id,
      items: { create: input.items },
    },
    include: { items: { include: { species: true } } },
  });
  const warnings = await record(dq, { Landing: { id: landing.id, label: landing.landingNo } });

  await publish({
    type: 'LandingReceived', source: 'OPERATIONS', target: 'OPERATIONS', entityType: 'Landing', entityId: landing.id,
    message: `${landing.landingNo}: ${vessel.name} landed ${totalGrossKg} kg (${landing.items.map((i) => i.species.name).join(', ')}) — waiting for grading`,
  });
  return { landing, warnings };
}

// ───────── QUALITY CONTROL: grade a landed species into lots (net weight + grade) ─────────

export async function gradeLandingItem(itemId: number, lots: { grade: Grade; netWeightKg: number }[]) {
  const item = await prisma.landingItem.findUnique({
    where: { id: itemId },
    include: { landing: true, species: true, lots: true },
  });
  if (!item) throw notFound('Landing item');
  if (item.gradedAt) throw badRequest(`${item.species.name} from ${item.landing.landingNo} was already graded`);

  const totalNetKg = item.lots.reduce((s, l) => s + l.netWeightKg, 0) + lots.reduce((s, l) => s + l.netWeightKg, 0);
  const dq = await validate('lot.grade', { grossWeightKg: item.grossWeightKg, totalNetKg });

  const expiresAt = new Date(item.landing.arrivedAt.getTime() + item.species.maxShelfHours * 3600_000);
  const created = [];
  for (const l of lots) {
    created.push(
      await prisma.lot.create({
        data: {
          lotNo: await nextNumber('LOT'),
          landingItemId: item.id,
          speciesId: item.speciesId,
          grade: l.grade,
          netWeightKg: l.netWeightKg,
          landedAt: item.landing.arrivedAt,
          expiresAt,
          gradedById: currentUser()?.id,
        },
      }),
    );
  }
  await prisma.landingItem.update({ where: { id: item.id }, data: { gradedAt: new Date() } });
  const warnings = await record(dq, { LandingItem: { id: item.id, label: `${item.landing.landingNo} · ${item.species.name}` } });

  await publish({
    type: 'LotGraded', source: 'OPERATIONS', target: 'OPERATIONS', entityType: 'LandingItem', entityId: item.id,
    message: `${created.length} lot(s) of ${item.species.name} graded (${created.map((l) => `${l.lotNo} ${l.grade} ${l.netWeightKg}kg`).join(', ')}) — waiting for cold storage`,
    payload: { lotIds: created.map((l) => l.id) },
  });

  // When every species of the landing is graded, Finance can compute the fisher's pay.
  const remaining = await prisma.landingItem.count({ where: { landingId: item.landingId, gradedAt: null } });
  if (remaining === 0) {
    await prisma.landing.update({ where: { id: item.landingId }, data: { status: 'GRADED' } });
    await publish({
      type: 'LandingGraded', source: 'OPERATIONS', target: 'FINANCE', entityType: 'Landing', entityId: item.landingId,
      message: `${item.landing.landingNo} fully graded — ready for fisher settlement`,
    });
  }
  return { lots: created, warnings };
}

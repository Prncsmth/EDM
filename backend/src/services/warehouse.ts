import { prisma } from '../db';
import { publish } from '../integration/bus';
import { validate, record, resolveIssues } from '../dq/engine';
import { badRequest, notFound } from '../lib/errors';
import { currentUser } from '../context';

// ───────── WAREHOUSE / COLD STORAGE ─────────

export async function unitLoadKg(storageUnitId: number) {
  const lots = await prisma.lot.findMany({ where: { storageUnitId, status: { in: ['IN_STORAGE', 'RESERVED', 'QUARANTINED'] } } });
  return lots.reduce((s, l) => s + (l.netWeightKg - l.dispatchedKg), 0);
}

export async function storeLot(lotId: number, storageUnitId: number) {
  const lot = await prisma.lot.findUnique({ where: { id: lotId }, include: { species: true } });
  if (!lot) throw notFound('Lot');
  if (lot.status !== 'GRADED') throw badRequest(`Lot ${lot.lotNo} is ${lot.status}, only GRADED lots can be put into storage`);
  const unit = await prisma.storageUnit.findUnique({ where: { id: storageUnitId } });
  if (!unit) throw notFound('Storage unit');

  const dq = await validate('lot.store', { lot, storageUnitId });

  const load = await unitLoadKg(unit.id);
  if (load + lot.netWeightKg > unit.capacityKg) {
    throw badRequest(`${unit.code} is full: ${Math.round(load)} kg stored, capacity ${unit.capacityKg} kg`);
  }

  const updated = await prisma.lot.update({
    where: { id: lot.id },
    data: { status: 'IN_STORAGE', storageUnitId: unit.id, storedAt: new Date() },
  });
  const warnings = await record(dq, { Lot: { id: lot.id, label: lot.lotNo } });
  await publish({
    type: 'LotStored', source: 'OPERATIONS', target: 'SALES', entityType: 'Lot', entityId: lot.id,
    message: `${lot.lotNo} (${lot.species.name}, Grade ${lot.grade}, ${lot.netWeightKg} kg) stored in ${unit.code} — available for sale`,
  });
  return { lot: updated, warnings };
}

export async function logTemperature(storageUnitId: number, readingC: number, recordedAt?: Date) {
  const unit = await prisma.storageUnit.findUnique({ where: { id: storageUnitId } });
  if (!unit) throw notFound('Storage unit');

  const dq = await validate('temp.save', { unit, readingC });
  const log = await prisma.temperatureLog.create({
    data: { storageUnitId: unit.id, readingC, recordedAt: recordedAt ?? new Date(), recordedById: currentUser()?.id },
  });
  const warnings = await record(dq, {
    TemperatureLog: { id: log.id, label: `${unit.code} @ ${log.recordedAt.toISOString().slice(0, 16).replace('T', ' ')}` },
    StorageUnit: { id: unit.id, label: unit.code },
  });

  // A fresh reading fixes DQ-14 ("no reading in the last N hours") for this unit.
  const dq14 = await prisma.dqRule.findUnique({ where: { code: 'DQ-14' } });
  if (dq14) await resolveIssues(dq14.id, 'StorageUnit', unit.id, 'Auto-resolved: new temperature reading');

  if (warnings.some((w) => w.code === 'DQ-12')) {
    await publish({
      type: 'TemperatureAlert', source: 'OPERATIONS', target: 'OPERATIONS', entityType: 'StorageUnit', entityId: unit.id,
      message: `${unit.code} reading ${readingC}°C is outside ${unit.minTempC}°C to ${unit.maxTempC}°C — check the unit`,
    });
  }
  return { log, warnings };
}

/** Disposes a quarantined (expired) or damaged lot. */
export async function markSpoiled(lotId: number, reason?: string) {
  const lot = await prisma.lot.findUnique({ where: { id: lotId } });
  if (!lot) throw notFound('Lot');
  if (!['QUARANTINED', 'IN_STORAGE', 'GRADED'].includes(lot.status)) throw badRequest(`Lot ${lot.lotNo} is ${lot.status} and cannot be marked spoiled`);
  if (lot.reservedKg > lot.dispatchedKg) throw badRequest(`Lot ${lot.lotNo} still has open sales reservations — cancel those orders first`);

  const updated = await prisma.lot.update({ where: { id: lot.id }, data: { status: 'SPOILED' } });
  await publish({
    type: 'LotSpoiled', source: 'OPERATIONS', target: 'FINANCE', entityType: 'Lot', entityId: lot.id,
    message: `${lot.lotNo} disposed as spoiled (${lot.netWeightKg - lot.dispatchedKg} kg write-off)${reason ? `: ${reason}` : ''}`,
  });
  return updated;
}

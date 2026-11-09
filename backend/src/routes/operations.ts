import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { allow } from '../middleware/auth';
import { notFound } from '../lib/errors';
import { id, idParam, num, optDate, optText, posNum, reqText } from '../lib/validation';
import { createLanding, gradeLandingItem } from '../services/portOps';
import { logTemperature, markSpoiled, storeLot, unitLoadKg } from '../services/warehouse';
import { cancelOrder, createOrder } from '../services/sales';
import { deliverDispatch, departDispatch } from '../services/logistics';
import { approveSettlement, paySettlement, recordPayment } from '../services/finance';

// Department workflows. Each POST goes through the DQ gate inside its service.
export const opsRouter = Router();

// ───────── Port operations & QC ─────────

const landingInclude = {
  vessel: { include: { owner: true } },
  receivedBy: { select: { name: true } },
  items: { include: { species: true, lots: true } },
  settlement: true,
} as const;

opsRouter.get('/landings', allow('OPERATIONS'), async (req, res) => {
  const status = req.query.status ? String(req.query.status) : undefined;
  res.json(await prisma.landing.findMany({ where: status ? { status: status as any } : {}, include: landingInclude, orderBy: { arrivedAt: 'desc' }, take: 200 }));
});

opsRouter.get('/landings/:id', allow('OPERATIONS'), async (req, res) => {
  const landing = await prisma.landing.findUnique({ where: { id: idParam(req.params.id) }, include: landingInclude });
  if (!landing) throw notFound('Landing');
  res.json(landing);
});

opsRouter.post('/landings', allow('OPERATIONS'), async (req, res) => {
  const body = z.object({
    vesselId: id,
    arrivedAt: optDate,
    notes: optText,
    items: z.array(z.object({ speciesId: id, grossWeightKg: posNum })).min(1, 'Add at least one species'),
  }).parse(req.body);
  res.status(201).json(await createLanding({ ...body, arrivedAt: body.arrivedAt ?? undefined, notes: body.notes ?? undefined }));
});

opsRouter.post('/landing-items/:id/grade', allow('OPERATIONS'), async (req, res) => {
  const { lots } = z.object({
    lots: z.array(z.object({ grade: z.enum(['A', 'B', 'C']), netWeightKg: posNum })).min(1, 'Add at least one lot'),
  }).parse(req.body);
  res.status(201).json(await gradeLandingItem(idParam(req.params.id), lots));
});

// ───────── Lots & cold storage ─────────

opsRouter.get('/lots', async (req, res) => {
  const where: any = {};
  if (req.query.status) where.status = { in: String(req.query.status).split(',') };
  if (req.query.speciesId) where.speciesId = Number(req.query.speciesId);
  if (req.query.storageUnitId) where.storageUnitId = Number(req.query.storageUnitId);
  const lots = await prisma.lot.findMany({
    where,
    include: { species: true, storageUnit: true, landingItem: { include: { landing: { include: { vessel: true } } } } },
    orderBy: { createdAt: 'desc' },
    take: 300,
  });
  res.json(lots.map((l) => ({ ...l, availableKg: Math.round((l.netWeightKg - l.reservedKg) * 100) / 100 })));
});

opsRouter.post('/lots/:id/store', allow('OPERATIONS'), async (req, res) => {
  const { storageUnitId } = z.object({ storageUnitId: id }).parse(req.body);
  res.json(await storeLot(idParam(req.params.id), storageUnitId));
});

opsRouter.post('/lots/:id/spoil', allow('OPERATIONS'), async (req, res) => {
  const { reason } = z.object({ reason: optText }).parse(req.body ?? {});
  res.json(await markSpoiled(idParam(req.params.id), reason ?? undefined));
});

opsRouter.get('/storage/overview', allow('OPERATIONS'), async (_req, res) => {
  const units = await prisma.storageUnit.findMany({
    orderBy: { code: 'asc' },
    include: { temperatureLogs: { orderBy: { recordedAt: 'desc' }, take: 12 } },
  });
  const out = [];
  for (const u of units) out.push({ ...u, loadKg: Math.round(await unitLoadKg(u.id)), latest: u.temperatureLogs[0] ?? null });
  res.json(out);
});

opsRouter.get('/temperature-logs', allow('OPERATIONS'), async (req, res) => {
  const where = req.query.storageUnitId ? { storageUnitId: Number(req.query.storageUnitId) } : {};
  res.json(await prisma.temperatureLog.findMany({ where, include: { storageUnit: true, recordedBy: { select: { name: true } } }, orderBy: { recordedAt: 'desc' }, take: 100 }));
});

opsRouter.post('/temperature-logs', allow('OPERATIONS'), async (req, res) => {
  const body = z.object({ storageUnitId: id, readingC: num, recordedAt: optDate }).parse(req.body);
  res.status(201).json(await logTemperature(body.storageUnitId, body.readingC, body.recordedAt ?? undefined));
});

// ───────── Sales ─────────

const orderInclude = {
  buyer: true,
  createdBy: { select: { name: true } },
  items: { include: { lot: { include: { species: true } }, dispatchItem: true } },
  dispatch: { include: { truck: true } },
  invoice: true,
} as const;

opsRouter.get('/sales-orders', allow('SALES'), async (_req, res) => {
  res.json(await prisma.salesOrder.findMany({ include: orderInclude, orderBy: { createdAt: 'desc' }, take: 200 }));
});

opsRouter.get('/sales-orders/:id', allow('SALES'), async (req, res) => {
  const order = await prisma.salesOrder.findUnique({ where: { id: idParam(req.params.id) }, include: orderInclude });
  if (!order) throw notFound('Sales order');
  res.json(order);
});

opsRouter.post('/sales-orders', allow('SALES'), async (req, res) => {
  const body = z.object({
    buyerId: id,
    items: z.array(z.object({ lotId: id, weightKg: posNum, pricePerKg: posNum })).min(1, 'Add at least one lot'),
  }).parse(req.body);
  res.status(201).json(await createOrder(body.buyerId, body.items));
});

opsRouter.post('/sales-orders/:id/cancel', allow('SALES'), async (req, res) => {
  res.json(await cancelOrder(idParam(req.params.id)));
});

// ───────── Logistics ─────────

opsRouter.get('/dispatches', allow('SALES'), async (_req, res) => {
  res.json(
    await prisma.dispatch.findMany({
      include: { truck: true, salesOrder: { include: { buyer: true } }, items: { include: { lot: { include: { species: true } } } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
  );
});

opsRouter.post('/dispatches/:id/depart', allow('SALES'), async (req, res) => {
  const { truckId } = z.object({ truckId: id }).parse(req.body);
  res.json(await departDispatch(idParam(req.params.id), truckId));
});

opsRouter.post('/dispatches/:id/deliver', allow('SALES'), async (req, res) => {
  const { items } = z.object({ items: z.array(z.object({ itemId: id, weightOutKg: posNum })).min(1) }).parse(req.body);
  res.json(await deliverDispatch(idParam(req.params.id), items));
});

// ───────── Finance ─────────

opsRouter.get('/invoices', allow('FINANCE'), async (_req, res) => {
  res.json(await prisma.invoice.findMany({ include: { buyer: true, salesOrder: true, items: true, payments: true }, orderBy: { issuedAt: 'desc' }, take: 200 }));
});

opsRouter.post('/invoices/:id/payments', allow('FINANCE'), async (req, res) => {
  const body = z.object({ amount: posNum, method: reqText, reference: optText }).parse(req.body);
  res.status(201).json(await recordPayment(idParam(req.params.id), { ...body, reference: body.reference ?? undefined }));
});

opsRouter.get('/settlements', allow('FINANCE'), async (_req, res) => {
  res.json(
    await prisma.fisherSettlement.findMany({
      include: { fisher: true, landing: { include: { vessel: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
  );
});

opsRouter.post('/settlements/:id/approve', allow('FINANCE'), async (req, res) => {
  res.json(await approveSettlement(idParam(req.params.id)));
});

opsRouter.post('/settlements/:id/pay', allow('FINANCE'), async (req, res) => {
  res.json(await paySettlement(idParam(req.params.id)));
});

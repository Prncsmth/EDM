import { prisma } from '../db';
import { publish } from '../integration/bus';
import { validateAll, record, DqBlockedError } from '../dq/engine';
import { badRequest, notFound } from '../lib/errors';
import { nextNumber } from '../lib/numbering';
import { currentUser } from '../context';

// ───────── SALES: sell stored lots to buyers ─────────

export async function createOrder(buyerId: number, items: { lotId: number; weightKg: number; pricePerKg: number }[]) {
  const buyer = await prisma.buyer.findUnique({ where: { id: buyerId } });
  if (!buyer) throw notFound('Buyer');
  if (buyer.status !== 'ACTIVE') throw badRequest(`Buyer ${buyer.businessName} is ${buyer.status}${buyer.mergedIntoId ? ` (merged into #${buyer.mergedIntoId})` : ''}`);

  const lots = await prisma.lot.findMany({ where: { id: { in: items.map((i) => i.lotId) } }, include: { species: true } });
  const lotById = new Map(lots.map((l) => [l.id, l]));
  for (const i of items) if (!lotById.has(i.lotId)) throw notFound(`Lot #${i.lotId}`);

  // The same lot may appear twice in one order → check the combined weight.
  const requestedByLot = new Map<number, number>();
  for (const i of items) requestedByLot.set(i.lotId, (requestedByLot.get(i.lotId) ?? 0) + i.weightKg);

  // DQ gate: DQ-06 price range (warn), DQ-09 over-selling (block), DQ-13 expired lot (block)
  const results = await validateAll(
    'order.confirm',
    items.map((i) => {
      const lot = lotById.get(i.lotId)!;
      return { lot, species: lot.species, pricePerKg: i.pricePerKg, requestedKg: requestedByLot.get(i.lotId) };
    }),
  );

  for (const lot of lots) {
    if (lot.status !== 'IN_STORAGE') throw badRequest(`Lot ${lot.lotNo} is ${lot.status} and cannot be sold`);
  }

  // Reserve atomically: the update only succeeds if enough weight is still available,
  // so two sales clerks can never sell the same kilograms (DQ-09 at the database level).
  const reserved: [number, number][] = [];
  for (const [lotId, kg] of requestedByLot) {
    const lot = lotById.get(lotId)!;
    const ok = await prisma.lot.updateMany({
      where: { id: lotId, reservedKg: { lte: lot.netWeightKg - kg + 0.001 } },
      data: { reservedKg: { increment: kg } },
    });
    if (ok.count === 0) {
      for (const [id, k] of reserved) await prisma.lot.update({ where: { id }, data: { reservedKg: { decrement: k } } });
      throw new DqBlockedError([{ code: 'DQ-09', name: 'No over-selling of a lot', severity: 'BLOCK', message: `Lot ${lot.lotNo} was just reserved by another order` }]);
    }
    reserved.push([lotId, kg]);
    const fresh = await prisma.lot.findUnique({ where: { id: lotId } });
    if (fresh && fresh.reservedKg >= fresh.netWeightKg - 0.001) await prisma.lot.update({ where: { id: lotId }, data: { status: 'RESERVED' } });
  }

  const order = await prisma.salesOrder.create({
    data: {
      orderNo: await nextNumber('SO'),
      buyerId,
      status: 'CONFIRMED',
      confirmedAt: new Date(),
      createdById: currentUser()?.id,
      items: { create: items.map((i) => ({ lotId: i.lotId, weightKg: i.weightKg, pricePerKg: i.pricePerKg })) },
    },
    include: { items: { include: { lot: true } }, buyer: true },
  });

  const warnings = [];
  for (let idx = 0; idx < order.items.length; idx++) {
    const it = order.items[idx];
    warnings.push(...(await record(results[idx], { SalesOrderItem: { id: it.id, label: `${order.orderNo} · ${it.lot.lotNo}` } })));
  }

  const totalKg = items.reduce((s, i) => s + i.weightKg, 0);
  await publish({
    type: 'SalesOrderConfirmed', source: 'SALES', target: 'SALES', entityType: 'SalesOrder', entityId: order.id,
    message: `${order.orderNo} for ${buyer.businessName}: ${totalKg} kg confirmed — needs a truck`,
  });
  return { order, warnings };
}

export async function cancelOrder(orderId: number) {
  const order = await prisma.salesOrder.findUnique({ where: { id: orderId }, include: { items: true, dispatch: true } });
  if (!order) throw notFound('Sales order');
  if (order.status !== 'CONFIRMED' || (order.dispatch && order.dispatch.status !== 'PENDING')) {
    throw badRequest(`${order.orderNo} is already ${order.dispatch?.status ?? order.status} and cannot be cancelled`);
  }
  for (const it of order.items) {
    const lot = await prisma.lot.update({ where: { id: it.lotId }, data: { reservedKg: { decrement: it.weightKg } } });
    if (lot.status === 'RESERVED') await prisma.lot.update({ where: { id: lot.id }, data: { status: 'IN_STORAGE' } });
  }
  if (order.dispatch) await prisma.dispatch.delete({ where: { id: order.dispatch.id } });
  const updated = await prisma.salesOrder.update({ where: { id: order.id }, data: { status: 'CANCELLED' } });
  await publish({
    type: 'SalesOrderCancelled', source: 'SALES', target: 'SALES', entityType: 'SalesOrder', entityId: order.id,
    message: `${order.orderNo} cancelled — reserved weight returned to stock`,
  });
  return updated;
}

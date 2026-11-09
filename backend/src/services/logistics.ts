import { prisma } from '../db';
import { publish } from '../integration/bus';
import { validateAll, record } from '../dq/engine';
import { badRequest, notFound } from '../lib/errors';
import { nextNumber } from '../lib/numbering';

// ───────── LOGISTICS: trucks, dispatch and delivery ─────────

/** Called automatically when Sales confirms an order. */
export async function createDispatchForOrder(salesOrderId: number) {
  const order = await prisma.salesOrder.findUnique({ where: { id: salesOrderId }, include: { items: true, dispatch: true } });
  if (!order) throw notFound('Sales order');
  if (order.dispatch) return order.dispatch;

  const dispatch = await prisma.dispatch.create({
    data: {
      dispatchNo: await nextNumber('DSP'),
      salesOrderId: order.id,
      items: { create: order.items.map((i) => ({ salesOrderItemId: i.id, lotId: i.lotId, orderedKg: i.weightKg })) },
    },
  });
  await publish({
    type: 'DispatchCreated', source: 'SALES', entityType: 'Dispatch', entityId: dispatch.id,
    message: `${dispatch.dispatchNo} created for ${order.orderNo} — assign a reefer truck`,
  });
  return dispatch;
}

export async function departDispatch(dispatchId: number, truckId: number) {
  const dispatch = await prisma.dispatch.findUnique({ where: { id: dispatchId }, include: { items: true, salesOrder: true } });
  if (!dispatch) throw notFound('Dispatch');
  if (dispatch.status !== 'PENDING') throw badRequest(`${dispatch.dispatchNo} is already ${dispatch.status}`);
  const truck = await prisma.truck.findUnique({ where: { id: truckId } });
  if (!truck) throw notFound('Truck');
  if (!truck.isReefer) throw badRequest(`${truck.plateNo} is not a refrigerated truck — seafood needs a reefer`);
  const totalKg = dispatch.items.reduce((s, i) => s + i.orderedKg, 0);
  if (totalKg > truck.capacityKg) throw badRequest(`${totalKg} kg exceeds ${truck.plateNo}'s capacity of ${truck.capacityKg} kg`);

  const updated = await prisma.dispatch.update({
    where: { id: dispatch.id },
    data: { truckId: truck.id, status: 'IN_TRANSIT', departedAt: new Date() },
  });
  await prisma.salesOrder.update({ where: { id: dispatch.salesOrderId }, data: { status: 'DISPATCHED' } });
  await publish({
    type: 'DispatchDeparted', source: 'SALES', target: 'SALES', entityType: 'Dispatch', entityId: dispatch.id,
    message: `${dispatch.dispatchNo} (${dispatch.salesOrder.orderNo}) left on ${truck.plateNo} with ${totalKg} kg`,
  });
  return updated;
}

/** Records the actual delivered weights. Triggers DQ-10 (shrinkage) and Finance invoicing. */
export async function deliverDispatch(dispatchId: number, weights: { itemId: number; weightOutKg: number }[]) {
  const dispatch = await prisma.dispatch.findUnique({
    where: { id: dispatchId },
    include: { items: { include: { lot: { include: { species: true } } } }, salesOrder: true },
  });
  if (!dispatch) throw notFound('Dispatch');
  if (dispatch.status !== 'IN_TRANSIT') throw badRequest(`${dispatch.dispatchNo} is ${dispatch.status}; it must be IN_TRANSIT to deliver`);

  const byId = new Map(weights.map((w) => [w.itemId, w.weightOutKg]));
  for (const it of dispatch.items) {
    const w = byId.get(it.id);
    if (w == null) throw badRequest(`Missing delivered weight for ${it.lot.lotNo}`);
    if (w > it.orderedKg) throw badRequest(`${it.lot.lotNo}: delivered ${w} kg is more than ordered ${it.orderedKg} kg`);
  }

  const results = await validateAll(
    'dispatch.deliver',
    dispatch.items.map((it) => ({ orderedKg: it.orderedKg, weightOutKg: byId.get(it.id)!, species: it.lot.species })),
  );

  const warnings = [];
  for (let idx = 0; idx < dispatch.items.length; idx++) {
    const it = dispatch.items[idx];
    const weightOutKg = byId.get(it.id)!;
    await prisma.dispatchItem.update({ where: { id: it.id }, data: { weightOutKg } });
    const lot = await prisma.lot.update({ where: { id: it.lotId }, data: { dispatchedKg: { increment: it.orderedKg } } });
    const pending = await prisma.dispatchItem.count({ where: { lotId: lot.id, weightOutKg: null } });
    if (lot.status === 'RESERVED' && pending === 0) await prisma.lot.update({ where: { id: lot.id }, data: { status: 'DELIVERED' } });
    warnings.push(...(await record(results[idx], { DispatchItem: { id: it.id, label: `${dispatch.dispatchNo} · ${it.lot.lotNo}` } })));
  }

  const updated = await prisma.dispatch.update({ where: { id: dispatch.id }, data: { status: 'DELIVERED', deliveredAt: new Date() } });
  await prisma.salesOrder.update({ where: { id: dispatch.salesOrderId }, data: { status: 'DELIVERED' } });

  if (warnings.length) {
    await publish({
      type: 'ShrinkageAlert', source: 'SALES', target: 'OPERATIONS', entityType: 'Dispatch', entityId: dispatch.id,
      message: `${dispatch.dispatchNo}: ${warnings.length} item(s) lost more weight than allowed — please investigate`,
    });
  }
  await publish({
    type: 'DispatchDelivered', source: 'SALES', target: 'FINANCE', entityType: 'Dispatch', entityId: dispatch.id,
    message: `${dispatch.dispatchNo} delivered for ${dispatch.salesOrder.orderNo} — ready for invoicing`,
    payload: { salesOrderId: dispatch.salesOrderId },
  });
  return { dispatch: updated, warnings };
}

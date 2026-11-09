import { Router } from 'express';
import { prisma } from '../db';
import { notFound } from '../lib/errors';
import { currentUser } from '../context';
import { allow } from '../middleware/auth';

// Dashboards, department inbox, traceability and logs.
export const insightsRouter = Router();

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

insightsRouter.get('/dashboard', async (_req, res) => {
  const [landedToday, stockLots, expiringSoon, openOrders, unpaid, events, openIssues] = await Promise.all([
    prisma.landingItem.aggregate({ _sum: { grossWeightKg: true }, where: { landing: { arrivedAt: { gte: startOfToday() } } } }),
    prisma.lot.findMany({ where: { status: { in: ['IN_STORAGE', 'RESERVED'] } }, include: { species: true } }),
    prisma.lot.findMany({
      where: { status: { in: ['GRADED', 'IN_STORAGE', 'RESERVED'] }, expiresAt: { lte: new Date(Date.now() + 12 * 3600_000) } },
      include: { species: true, storageUnit: true },
      orderBy: { expiresAt: 'asc' },
      take: 10,
    }),
    prisma.salesOrder.count({ where: { status: { in: ['CONFIRMED', 'DISPATCHED'] } } }),
    prisma.invoice.findMany({ where: { status: { not: 'PAID' } }, select: { total: true, amountPaid: true } }),
    prisma.integrationEvent.findMany({ orderBy: { createdAt: 'desc' }, take: 12 }),
    prisma.dqIssue.count({ where: { status: 'OPEN' } }),
  ]);

  const stock = new Map<string, { species: string; availableKg: number; storedKg: number }>();
  for (const l of stockLots) {
    const s = stock.get(l.species.name) ?? { species: l.species.name, availableKg: 0, storedKg: 0 };
    s.availableKg += l.netWeightKg - l.reservedKg;
    s.storedKg += l.netWeightKg - l.dispatchedKg;
    stock.set(l.species.name, s);
  }

  const [arrivals, departures] = await Promise.all([boardArrivals(8), boardDepartures(8)]);

  res.json({
    arrivals,
    departures,
    kpis: {
      landedTodayKg: Math.round(landedToday._sum.grossWeightKg ?? 0),
      inStorageKg: Math.round([...stock.values()].reduce((s, x) => s + x.storedKg, 0)),
      openOrders,
      receivables: Math.round(unpaid.reduce((s, i) => s + Number(i.total) - Number(i.amountPaid), 0)),
      openIssues,
    },
    stock: [...stock.values()].map((s) => ({ ...s, availableKg: Math.round(s.availableKg), storedKg: Math.round(s.storedKg) })),
    expiringSoon,
    events,
  });
});

// ───────── Airport-style boards: ARRIVALS (boats landing) and DEPARTURES (trucks leaving) ─────────

export type BoardRow = {
  id: number;
  time: string;
  code: string;
  title: string;
  detail: string;
  kg: number;
  status: string;
  tone: 'amber' | 'green' | 'cyan' | 'red';
  live: boolean; // blinking = waiting for someone to act
};

async function boardArrivals(take: number): Promise<BoardRow[]> {
  const landings = await prisma.landing.findMany({
    orderBy: { arrivedAt: 'desc' },
    take,
    include: { vessel: true, items: { include: { species: true, lots: true } } },
  });
  return landings.map((l) => {
    const lots = l.items.flatMap((i) => i.lots);
    let status: Pick<BoardRow, 'status' | 'tone' | 'live'> = { status: 'IN STORAGE', tone: 'green', live: false };
    if (l.status === 'RECEIVED') status = { status: 'AWAITING QC', tone: 'amber', live: true };
    else if (lots.some((x) => x.status === 'QUARANTINED')) status = { status: 'EXPIRED', tone: 'red', live: true };
    else if (lots.some((x) => x.status === 'GRADED')) status = { status: 'TO STORAGE', tone: 'amber', live: true };
    else if (lots.length && lots.every((x) => ['DELIVERED', 'SPOILED'].includes(x.status))) status = { status: 'SOLD OUT', tone: 'cyan', live: false };
    return {
      id: l.id,
      time: l.arrivedAt.toISOString(),
      code: l.landingNo,
      title: l.vessel.name,
      detail: l.items.map((i) => i.species.localName ?? i.species.name).join(' · '),
      kg: Math.round(l.items.reduce((s, i) => s + i.grossWeightKg, 0)),
      ...status,
    };
  });
}

async function boardDepartures(take: number): Promise<BoardRow[]> {
  const dispatches = await prisma.dispatch.findMany({
    orderBy: { createdAt: 'desc' },
    take,
    include: { truck: true, items: true, salesOrder: { include: { buyer: true } } },
  });
  const STATUS = {
    PENDING: { status: 'AWAITING TRUCK', tone: 'amber', live: true },
    IN_TRANSIT: { status: 'DEPARTED', tone: 'cyan', live: true },
    DELIVERED: { status: 'DELIVERED', tone: 'green', live: false },
  } as const;
  return dispatches.map((d) => ({
    id: d.id,
    time: (d.deliveredAt ?? d.departedAt ?? d.createdAt).toISOString(),
    code: d.dispatchNo,
    title: d.salesOrder.buyer.businessName,
    detail: d.truck ? d.truck.plateNo : 'No truck yet',
    kg: Math.round(d.items.reduce((s, i) => s + (i.weightOutKg ?? i.orderedKg), 0)),
    ...STATUS[d.status],
  }));
}

insightsRouter.get('/boards/:type', async (req, res) => {
  const take = Math.min(30, Number(req.query.take ?? 12));
  if (req.params.type === 'arrivals') return res.json(await boardArrivals(take));
  if (req.params.type === 'departures') return res.json(await boardDepartures(take));
  res.status(404).json({ error: 'Unknown board' });
});

/** What each department needs to do next — the hand-offs from other departments. */
insightsRouter.get('/inbox', async (_req, res) => {
  const dept = currentUser()!.department;
  const all = dept === 'ADMIN';
  const tasks: { department: string; title: string; count: number; href: string }[] = [];
  const add = async (d: string, title: string, href: string, count: Promise<number>) => {
    if (all || d === dept) tasks.push({ department: d, title, href, count: await count });
  };
  await add('OPERATIONS', 'Landings waiting for grading', '/landings', prisma.landing.count({ where: { status: 'RECEIVED' } }));
  await add('OPERATIONS', 'Graded lots waiting for cold storage', '/storage', prisma.lot.count({ where: { status: 'GRADED' } }));
  await add('OPERATIONS', 'Quarantined lots to dispose', '/storage', prisma.lot.count({ where: { status: 'QUARANTINED' } }));
  await add('SALES', 'Lots available for sale', '/sales', prisma.lot.count({ where: { status: 'IN_STORAGE' } }));
  await add('SALES', 'Dispatches needing a truck', '/dispatch', prisma.dispatch.count({ where: { status: 'PENDING' } }));
  await add('SALES', 'Deliveries in transit', '/dispatch', prisma.dispatch.count({ where: { status: 'IN_TRANSIT' } }));
  await add('FINANCE', 'Fisher settlements to approve / pay', '/finance', prisma.fisherSettlement.count({ where: { status: { in: ['DRAFT', 'APPROVED'] } } }));
  await add('FINANCE', 'Unpaid invoices', '/finance', prisma.invoice.count({ where: { status: { not: 'PAID' } } }));
  const issues = await prisma.dqIssue.count({ where: { status: 'OPEN', ...(all ? {} : { department: dept }) } });
  tasks.push({ department: dept, title: all ? 'Open data quality issues (all departments)' : 'Open data quality issues for your department', href: '/dq/issues', count: issues });
  res.json(tasks);
});

/** Full history of one lot: boat → fisher → grading → storage temps → buyer → truck → invoice. */
insightsRouter.get('/trace/:lotNo', async (req, res) => {
  const lot = await prisma.lot.findUnique({
    where: { lotNo: String(req.params.lotNo).trim().toUpperCase() },
    include: {
      species: true,
      gradedBy: { select: { name: true } },
      storageUnit: { include: { temperatureLogs: { orderBy: { recordedAt: 'desc' }, take: 20 } } },
      landingItem: {
        include: {
          landing: { include: { vessel: { include: { owner: true } }, receivedBy: { select: { name: true } }, settlement: true } },
        },
      },
      orderItems: {
        include: {
          salesOrder: { include: { buyer: true, invoice: { include: { payments: true } }, dispatch: { include: { truck: true } } } },
          dispatchItem: true,
        },
      },
    },
  });
  if (!lot) throw notFound(`Lot ${req.params.lotNo}`);
  const [events, issues] = await Promise.all([
    prisma.integrationEvent.findMany({
      where: {
        OR: [
          { entityType: 'Lot', entityId: lot.id },
          { entityType: 'LandingItem', entityId: lot.landingItemId },
          { entityType: 'Landing', entityId: lot.landingItem.landingId },
          { entityType: 'SalesOrder', entityId: { in: lot.orderItems.map((o) => o.salesOrderId) } },
          { entityType: 'Dispatch', entityId: { in: lot.orderItems.map((o) => o.salesOrder.dispatch?.id).filter(Boolean) as number[] } },
          { entityType: 'Invoice', entityId: { in: lot.orderItems.map((o) => o.salesOrder.invoice?.id).filter(Boolean) as number[] } },
        ],
      },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.dqIssue.findMany({
      where: {
        OR: [
          { entityType: 'Lot', entityId: lot.id },
          { entityType: 'SalesOrderItem', entityId: { in: lot.orderItems.map((o) => o.id) } },
          { entityType: 'DispatchItem', entityId: { in: lot.orderItems.map((o) => o.dispatchItem?.id).filter(Boolean) as number[] } },
        ],
      },
      include: { rule: true },
    }),
  ]);
  res.json({ lot, events, issues });
});

insightsRouter.get('/events', async (req, res) => {
  const where: any = {};
  if (req.query.department) where.OR = [{ sourceDept: req.query.department }, { targetDept: req.query.department }];
  res.json(await prisma.integrationEvent.findMany({ where, orderBy: { createdAt: 'desc' }, take: 300 }));
});

insightsRouter.get('/audit-logs', allow('ADMIN'), async (req, res) => {
  const where: any = {};
  if (req.query.entityType) where.entityType = String(req.query.entityType);
  if (req.query.entityId) where.entityId = Number(req.query.entityId);
  res.json(await prisma.auditLog.findMany({ where, include: { user: { select: { name: true, department: true } } }, orderBy: { createdAt: 'desc' }, take: 300 }));
});

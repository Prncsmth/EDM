import { prisma } from '../db';
import { publish } from '../integration/bus';
import { validate, record } from '../dq/engine';
import { badRequest, notFound } from '../lib/errors';
import { nextNumber } from '../lib/numbering';
import { currentUser } from '../context';
import { SETTLEMENT } from '../config';

// ───────── FINANCE: fisher settlements (pay-out) and buyer invoices (collection) ─────────

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Called automatically when QC finishes grading a landing. */
export async function createSettlementDraft(landingId: number) {
  const landing = await prisma.landing.findUnique({
    where: { id: landingId },
    include: { vessel: { include: { owner: true } }, items: { include: { lots: { include: { species: true } } } }, settlement: true },
  });
  if (!landing) throw notFound('Landing');
  if (landing.settlement) return landing.settlement;

  const lots = landing.items.flatMap((i) => i.lots);
  const totalNetKg = round2(lots.reduce((s, l) => s + l.netWeightKg, 0));
  const gross = round2(lots.reduce((s, l) => s + l.netWeightKg * Number(l.species.buyingPricePerKg) * SETTLEMENT.gradeFactor[l.grade], 0));
  const portFee = round2(gross * SETTLEMENT.portFeeRate);
  const iceFee = round2(totalNetKg * SETTLEMENT.iceFeePerKg);

  const settlement = await prisma.fisherSettlement.create({
    data: {
      settlementNo: await nextNumber('STL'),
      landingId: landing.id,
      fisherId: landing.vessel.ownerId,
      totalNetKg,
      grossAmount: gross,
      portFee,
      iceFee,
      netAmount: round2(gross - portFee - iceFee),
    },
  });
  await publish({
    type: 'SettlementDrafted', source: 'FINANCE', entityType: 'FisherSettlement', entityId: settlement.id,
    message: `${settlement.settlementNo}: ₱${round2(gross - portFee - iceFee).toLocaleString()} due to ${landing.vessel.owner.name} for ${landing.landingNo} — waiting for approval`,
  });
  return settlement;
}

async function settlementWithFisher(id: number) {
  const s = await prisma.fisherSettlement.findUnique({ where: { id }, include: { fisher: true } });
  if (!s) throw notFound('Settlement');
  return s;
}

export async function approveSettlement(id: number) {
  const s = await settlementWithFisher(id);
  if (s.status !== 'DRAFT') throw badRequest(`${s.settlementNo} is already ${s.status}`);
  const dq = await validate('settlement.approve', { fisher: s.fisher }); // DQ-01 blocks if TIN / payout missing
  const updated = await prisma.fisherSettlement.update({ where: { id }, data: { status: 'APPROVED', approvedAt: new Date() } });
  await record(dq, { Fisher: { id: s.fisher.id, label: s.fisher.name } });
  return updated;
}

export async function paySettlement(id: number) {
  const s = await settlementWithFisher(id);
  if (s.status !== 'APPROVED') throw badRequest(`${s.settlementNo} must be APPROVED before paying (now ${s.status})`);
  await validate('settlement.approve', { fisher: s.fisher });
  const updated = await prisma.fisherSettlement.update({ where: { id }, data: { status: 'PAID', paidAt: new Date() } });
  await publish({
    type: 'SettlementPaid', source: 'FINANCE', target: 'OPERATIONS', entityType: 'FisherSettlement', entityId: id,
    message: `${s.settlementNo}: ₱${Number(s.netAmount).toLocaleString()} paid to ${s.fisher.name} via ${s.fisher.payoutMethod}`,
  });
  return updated;
}

/** Called automatically when Logistics delivers. Bills the DELIVERED weight, not the ordered weight. */
export async function createInvoiceForOrder(salesOrderId: number) {
  const order = await prisma.salesOrder.findUnique({
    where: { id: salesOrderId },
    include: { buyer: true, invoice: true, items: { include: { dispatchItem: true, lot: { include: { species: true } } } } },
  });
  if (!order) throw notFound('Sales order');
  if (order.invoice) return order.invoice;

  const items = order.items.map((i) => {
    const weightKg = i.dispatchItem?.weightOutKg ?? i.weightKg;
    return {
      description: `${i.lot.species.name} Grade ${i.lot.grade} · ${i.lot.lotNo}`,
      weightKg,
      pricePerKg: i.pricePerKg,
      amount: round2(weightKg * Number(i.pricePerKg)),
    };
  });
  const total = round2(items.reduce((s, i) => s + i.amount, 0));
  const dq = await validate('invoice.save', { total, items }); // DQ-11

  const invoice = await prisma.invoice.create({
    data: {
      invoiceNo: await nextNumber('INV'),
      buyerId: order.buyerId,
      salesOrderId: order.id,
      total,
      dueAt: new Date(Date.now() + 15 * 86400_000),
      items: { create: items },
    },
  });
  await record(dq, { Invoice: { id: invoice.id, label: invoice.invoiceNo } });
  await publish({
    type: 'InvoiceIssued', source: 'FINANCE', target: 'SALES', entityType: 'Invoice', entityId: invoice.id,
    message: `${invoice.invoiceNo}: ₱${total.toLocaleString()} billed to ${order.buyer.businessName} for ${order.orderNo}`,
  });
  return invoice;
}

export async function recordPayment(invoiceId: number, input: { amount: number; method: string; reference?: string }) {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: { buyer: true } });
  if (!invoice) throw notFound('Invoice');
  const balance = round2(Number(invoice.total) - Number(invoice.amountPaid));
  if (input.amount <= 0) throw badRequest('Amount must be more than zero');
  if (input.amount > balance + 0.001) throw badRequest(`Payment ₱${input.amount} is more than the balance ₱${balance}`);

  const payment = await prisma.payment.create({
    data: { invoiceId, amount: input.amount, method: input.method, reference: input.reference, receivedById: currentUser()?.id },
  });
  const paid = round2(Number(invoice.amountPaid) + input.amount);
  await prisma.invoice.update({
    where: { id: invoiceId },
    data: { amountPaid: paid, status: paid >= Number(invoice.total) - 0.001 ? 'PAID' : 'PARTIAL' },
  });
  await publish({
    type: 'PaymentReceived', source: 'FINANCE', target: 'SALES', entityType: 'Invoice', entityId: invoiceId,
    message: `₱${input.amount.toLocaleString()} received from ${invoice.buyer.businessName} for ${invoice.invoiceNo} (balance ₱${round2(balance - input.amount).toLocaleString()})`,
  });
  return payment;
}

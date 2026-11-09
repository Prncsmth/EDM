import { prisma } from '../db';

// Readable document numbers like LOT-261109-0003 (prefix-YYMMDD-sequence).
function today() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

const COUNTERS = {
  LND: { model: 'landing', field: 'landingNo' },
  LOT: { model: 'lot', field: 'lotNo' },
  SO: { model: 'salesOrder', field: 'orderNo' },
  DSP: { model: 'dispatch', field: 'dispatchNo' },
  INV: { model: 'invoice', field: 'invoiceNo' },
  STL: { model: 'fisherSettlement', field: 'settlementNo' },
} as const;

export async function nextNumber(prefix: keyof typeof COUNTERS, db: any = prisma) {
  const { model, field } = COUNTERS[prefix];
  const stem = `${prefix}-${today()}-`;
  const last = await db[model].findFirst({
    where: { [field]: { startsWith: stem } },
    orderBy: { [field]: 'desc' },
    select: { [field]: true },
  });
  const seq = last ? Number(String(last[field]).slice(stem.length)) + 1 : 1;
  return `${stem}${String(seq).padStart(4, '0')}`;
}

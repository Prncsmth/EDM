import { PrismaClient } from '@prisma/client';
import { currentUser } from './context';

const base = new PrismaClient();

// Models whose changes are written to the audit log.
const AUDITED = new Set([
  'User', 'Species', 'Fisher', 'Vessel', 'Buyer', 'StorageUnit', 'Truck',
  'Landing', 'Lot', 'SalesOrder', 'Dispatch', 'Invoice', 'Payment', 'FisherSettlement', 'DqRule',
]);

const toJson = (row: any) => {
  if (!row || typeof row !== 'object') return undefined;
  const { passwordHash, ...rest } = row;
  return JSON.parse(JSON.stringify(rest));
};

const lower = (model: string) => model.charAt(0).toLowerCase() + model.slice(1);

async function writeAudit(action: string, model: string, entityId: number | undefined, before: any, after: any) {
  try {
    await base.auditLog.create({
      data: { action, entityType: model, entityId, userId: currentUser()?.id, before: toJson(before), after: toJson(after) },
    });
  } catch (e) {
    console.error('audit log failed', e);
  }
}

// Prisma client with an automatic audit trail on create / update / delete.
export const prisma = base.$extends({
  query: {
    $allModels: {
      async create({ model, args, query }) {
        const result: any = await query(args);
        if (AUDITED.has(model)) await writeAudit('CREATE', model, result?.id, null, result);
        return result;
      },
      async update({ model, args, query }) {
        if (!AUDITED.has(model)) return query(args);
        const before = await (base as any)[lower(model)].findUnique({ where: args.where });
        const result: any = await query(args);
        await writeAudit('UPDATE', model, result?.id, before, result);
        return result;
      },
      async delete({ model, args, query }) {
        if (!AUDITED.has(model)) return query(args);
        const before = await (base as any)[lower(model)].findUnique({ where: args.where });
        const result: any = await query(args);
        await writeAudit('DELETE', model, before?.id, before, null);
        return result;
      },
    },
  },
});

export const auditMerge = (model: string, keptId: number, removed: any) => writeAudit('MERGE', model, keptId, removed, { mergedInto: keptId });

export type Db = typeof prisma;
export { base as rawPrisma };

import { Router } from 'express';
import { z } from 'zod';
import type { Department } from '@prisma/client';
import { prisma } from '../db';
import { allow } from '../middleware/auth';
import { HttpError, notFound } from '../lib/errors';
import { cleanBuyer, cleanFisher, cleanName, cleanText } from '../lib/cleanse';
import { id, idParam, num, optText, posNum, reqText } from '../lib/validation';
import { validate, record } from '../dq/engine';
import { mergeBuyers, mergeFishers } from '../services/merge';

// ─────────────────────────────────────────────────────────────
// Master data — shared by every department.
// Fishers and buyers go through cleansing + DQ checks before saving.
// ─────────────────────────────────────────────────────────────

export const masterRouter = Router();

type CrudConfig = {
  path: string;
  model: string;
  schema: z.ZodObject<any>;
  writers: Department[];
  orderBy: Record<string, 'asc' | 'desc'>;
  include?: Record<string, any>;
  search?: string[];
  beforeSave?: (data: any) => any; // cleansing
  dq?: { context: string; table: 'Fisher' | 'Buyer'; nameField: string };
};

function crud(cfg: CrudConfig) {
  const delegate = () => (prisma as any)[cfg.model];

  masterRouter.get(`/${cfg.path}`, async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const status = req.query.status ? String(req.query.status) : undefined;
    const where: any = {};
    if (q && cfg.search) where.OR = cfg.search.map((f) => ({ [f]: { contains: q, mode: 'insensitive' } }));
    if (status) where.status = status;
    res.json(await delegate().findMany({ where, orderBy: cfg.orderBy, include: cfg.include }));
  });

  masterRouter.get(`/${cfg.path}/:id`, async (req, res) => {
    const row = await delegate().findUnique({ where: { id: idParam(req.params.id) }, include: cfg.include });
    if (!row) throw notFound(cfg.model);
    res.json(row);
  });

  const save = async (data: any, existingId: number | null) => {
    if (cfg.beforeSave) data = cfg.beforeSave(data);
    let dq = null;
    if (cfg.dq) {
      // DQ-03 format + DQ-08 duplicates (on the cleansed data)
      dq = await validate(cfg.dq.context, {
        data,
        table: cfg.dq.table,
        name: data[cfg.dq.nameField],
        phone: data.phone,
        id: existingId,
      });
    }
    const row = existingId
      ? await delegate().update({ where: { id: existingId }, data, include: cfg.include })
      : await delegate().create({ data, include: cfg.include });
    const warnings = dq ? await record(dq, { [cfg.dq!.table]: { id: row.id, label: row[cfg.dq!.nameField] } }) : [];
    return { ...row, dqWarnings: warnings };
  };

  masterRouter.post(`/${cfg.path}`, allow(...cfg.writers), async (req, res) => {
    res.status(201).json(await save(cfg.schema.parse(req.body), null));
  });

  masterRouter.put(`/${cfg.path}/:id`, allow(...cfg.writers), async (req, res) => {
    const rowId = idParam(req.params.id);
    if (!(await delegate().findUnique({ where: { id: rowId } }))) throw notFound(cfg.model);
    res.json(await save(cfg.schema.parse(req.body), rowId));
  });

  masterRouter.delete(`/${cfg.path}/:id`, allow('ADMIN'), async (req, res) => {
    try {
      await delegate().delete({ where: { id: idParam(req.params.id) } });
      res.status(204).end();
    } catch (e: any) {
      if (e?.code === 'P2003') throw new HttpError(409, 'This record is used by transactions. Set it to INACTIVE instead of deleting.');
      throw e;
    }
  });
}

const status = z.enum(['ACTIVE', 'INACTIVE']).optional();

crud({
  path: 'species', model: 'species', writers: ['ADMIN', 'OPERATIONS'], orderBy: { name: 'asc' }, search: ['name', 'localName'],
  beforeSave: (d) => ({ ...d, name: cleanName(d.name), localName: cleanName(d.localName) }),
  schema: z.object({
    name: reqText, localName: optText,
    buyingPricePerKg: posNum, minSellPricePerKg: posNum, maxSellPricePerKg: posNum,
    maxShelfHours: z.coerce.number().int().positive(), shrinkageTolerancePct: num.min(0).max(100),
    minTempC: num, maxTempC: num,
  }).refine((s) => s.minSellPricePerKg <= s.maxSellPricePerKg, { message: 'Min price must be ≤ max price', path: ['minSellPricePerKg'] })
    .refine((s) => s.minTempC <= s.maxTempC, { message: 'Min temp must be ≤ max temp', path: ['minTempC'] }) as any,
});

crud({
  path: 'fishers', model: 'fisher', writers: ['ADMIN', 'OPERATIONS'], orderBy: { name: 'asc' }, search: ['name', 'phone', 'tin'],
  include: { vessels: true }, beforeSave: cleanFisher,
  dq: { context: 'fisher.save', table: 'Fisher', nameField: 'name' },
  schema: z.object({
    name: reqText, phone: optText, tin: optText, address: optText,
    payoutMethod: z.preprocess((v) => (v === '' ? null : v), z.enum(['GCASH', 'BANK', 'CASH']).nullable().optional()),
    payoutAccount: optText, status,
  }),
});

crud({
  path: 'buyers', model: 'buyer', writers: ['ADMIN', 'SALES'], orderBy: { businessName: 'asc' }, search: ['businessName', 'contactPerson', 'phone'],
  beforeSave: cleanBuyer,
  dq: { context: 'buyer.save', table: 'Buyer', nameField: 'businessName' },
  schema: z.object({
    businessName: reqText, contactPerson: optText, phone: optText, email: optText, tin: optText, address: optText,
    creditLimit: num.min(0).default(0), status,
  }),
});

crud({
  path: 'vessels', model: 'vessel', writers: ['ADMIN', 'OPERATIONS'], orderBy: { name: 'asc' }, search: ['name', 'registrationNo'],
  include: { owner: true },
  beforeSave: (d) => ({ ...d, name: cleanText(d.name)?.toUpperCase(), registrationNo: cleanText(d.registrationNo)?.toUpperCase() }),
  schema: z.object({ registrationNo: reqText, name: reqText, ownerId: id, capacityKg: posNum }),
});

crud({
  path: 'storage-units', model: 'storageUnit', writers: ['ADMIN', 'OPERATIONS'], orderBy: { code: 'asc' }, search: ['code'],
  beforeSave: (d) => ({ ...d, code: cleanText(d.code)?.toUpperCase() }),
  schema: z.object({ code: reqText, type: z.enum(['BLAST_FREEZER', 'CHILLER']), capacityKg: posNum, minTempC: num, maxTempC: num }),
});

crud({
  path: 'trucks', model: 'truck', writers: ['ADMIN', 'SALES'], orderBy: { plateNo: 'asc' }, search: ['plateNo'],
  beforeSave: (d) => ({ ...d, plateNo: cleanText(d.plateNo)?.toUpperCase() }),
  schema: z.object({ plateNo: reqText, capacityKg: posNum, isReefer: z.coerce.boolean() }),
});

// ───────── Merge duplicates (DQ-08) ─────────

const mergeBody = z.object({ keepId: id });

masterRouter.post('/fishers/:id/merge', allow('ADMIN'), async (req, res) => {
  res.json(await mergeFishers(idParam(req.params.id), mergeBody.parse(req.body).keepId));
});

masterRouter.post('/buyers/:id/merge', allow('ADMIN'), async (req, res) => {
  res.json(await mergeBuyers(idParam(req.params.id), mergeBody.parse(req.body).keepId));
});

import { on } from './bus';
import { createSettlementDraft, createInvoiceForOrder } from '../services/finance';
import { createDispatchForOrder } from '../services/logistics';

// ─────────────────────────────────────────────────────────────
// Automatic hand-offs between departments.
//
//   QC grades a landing       → Finance drafts the fisher's settlement
//   Sales confirms an order   → Logistics gets a dispatch to schedule
//   Logistics delivers        → Finance issues the buyer's invoice
// ─────────────────────────────────────────────────────────────

export function registerIntegrationHandlers() {
  on('LandingGraded', async (e) => {
    await createSettlementDraft(e.entityId);
  });

  on('SalesOrderConfirmed', async (e) => {
    await createDispatchForOrder(e.entityId);
  });

  on('DispatchDelivered', async (e) => {
    await createInvoiceForOrder(Number(e.payload?.salesOrderId));
  });
}

import type { Department } from '@prisma/client';
import { prisma } from '../db';

// ─────────────────────────────────────────────────────────────
// Department Integration — a small in-process event bus.
//
// When one department finishes its step it PUBLISHES an event
// (e.g. "LotGraded"). The event is saved to the IntegrationEvent
// table (the integration log) and every HANDLER subscribed to it
// runs, doing the next department's automatic work.
// ─────────────────────────────────────────────────────────────

export type BusEvent = {
  type: string;
  source: Department;
  target?: Department;
  entityType: string;
  entityId: number;
  message: string;
  payload?: Record<string, unknown>;
};

type Handler = (event: BusEvent) => Promise<void>;
const handlers = new Map<string, Handler[]>();

export function on(type: string, handler: Handler) {
  handlers.set(type, [...(handlers.get(type) ?? []), handler]);
}

export async function publish(event: BusEvent) {
  await prisma.integrationEvent.create({
    data: {
      type: event.type,
      sourceDept: event.source,
      targetDept: event.target,
      entityType: event.entityType,
      entityId: event.entityId,
      message: event.message,
      payload: (event.payload ?? {}) as any,
    },
  });
  for (const handler of handlers.get(event.type) ?? []) {
    try {
      await handler(event);
    } catch (err) {
      // A failing hand-off must not undo the step that already happened; log it instead.
      console.error(`Handler for ${event.type} failed`, err);
      await prisma.integrationEvent.create({
        data: {
          type: 'HandlerFailed',
          sourceDept: event.target ?? event.source,
          entityType: event.entityType,
          entityId: event.entityId,
          message: `Automatic step after ${event.type} failed: ${(err as Error).message}`,
        },
      });
    }
  }
}

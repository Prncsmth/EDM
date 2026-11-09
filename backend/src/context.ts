import { AsyncLocalStorage } from 'node:async_hooks';
import type { Department } from '@prisma/client';

export type AuthUser = { id: number; name: string; email: string; department: Department };

// Holds the logged-in user for the current request, so the audit log
// can record "who changed what" without passing the user everywhere.
export const requestContext = new AsyncLocalStorage<{ user?: AuthUser }>();

export const currentUser = () => requestContext.getStore()?.user;

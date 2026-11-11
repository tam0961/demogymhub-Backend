import type { Request } from 'express';
import { forbidden } from '../../lib/errors';
import { branchAllowed } from './service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Returns a prisma `branchId` filter for list queries, honoring X-Branch-Id and an explicit branch_id. */
export function branchFilter(req: Request, explicit?: string): { branchId?: string | { in: string[] } } {
  const access = req.access!;
  const wanted = explicit || (req.header('x-branch-id') ?? undefined);
  if (wanted) {
    if (!UUID_RE.test(wanted) || !branchAllowed(access, wanted)) throw forbidden('Branch not permitted');
    return { branchId: wanted };
  }
  if (req.access!.roles.includes('super_admin') || access.allBranches) return {};
  return { branchId: { in: access.branchIds } };
}

/** Resolves the branch a write targets; defaults to the header or the user's single branch. */
export function writeBranch(req: Request, bodyBranch?: string): string {
  const access = req.access!;
  const id = bodyBranch || req.header('x-branch-id') || (access.branchIds.length === 1 ? access.branchIds[0] : undefined);
  if (!id) throw forbidden('branch_id required');
  if (!UUID_RE.test(id) || !branchAllowed(access, id)) throw forbidden('Branch not permitted');
  return id;
}

export function assertBranch(req: Request, branchId: string) {
  if (!branchAllowed(req.access!, branchId)) return false;
  return true;
}

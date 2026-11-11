import type { NextFunction, Request, Response } from 'express';
import { HttpError, badRequest } from '../../lib/errors';
import type { Access } from '../rbac/service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VIEW_ONLY_MSG = 'Tài khoản quản trị chỉ xem thống kê, không thực hiện check-in.';

const viewOnlyError = () => new HttpError(403, 'VIEW_ONLY', VIEW_ONLY_MSG);

export const isAdminAccess = (a: Access) => a.allBranches || a.roles.includes('super_admin') || a.roles.includes('owner');

/** Runs before authorize so owner/super_admin always get VIEW_ONLY rather than a plain permission error. */
export function denyViewOnly(req: Request, _res: Response, next: NextFunction) {
  const a = req.access;
  if (a && (a.roles.includes('super_admin') || a.roles.includes('owner'))) throw viewOnlyError();
  next();
}

/** Branch the staff member checks in at, from the server-side role scope only. */
export function requireBranchStaff(req: Request): string {
  const a = req.access!;
  if (isAdminAccess(a)) throw viewOnlyError();
  if (a.branchIds.length === 1) return a.branchIds[0];
  const h = req.header('x-branch-id');
  if (h && UUID_RE.test(h) && a.branchIds.includes(h)) return h;
  throw badRequest('BRANCH_REQUIRED', 'X-Branch-Id is required and must be one of your branches');
}

export function canCheckin(a: Access) {
  return !isAdminAccess(a) && a.permissions.includes('checkins.create') && a.branchIds.length > 0;
}

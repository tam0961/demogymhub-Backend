import crypto from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';

/** The booking Apps Script bridge that the old booking.thgym.com used (it submits to the Google Form, which updates the Sheet). */
export const DEFAULT_BRIDGE_URL = 'https://script.google.com/macros/s/AKfycbyd63XdNpG4kbEpBcohTK5by4goToE1AaC5sJnrz4ioXPfDLQAmXnhSqdK-7IMAqe4l/exec';

export interface SheetSyncCfg {
  /** Write every registration made in the app to the old Sheet through the bridge (until the owner cuts the Sheet). */
  writeOn: boolean;
  bridgeUrl: string;
  /** Pull Members, registrations, classes and schedule from the old Sheet into the app every 5 minutes. */
  pullOn: boolean;
  /** Web app URL of the dump script the owner pastes into the Sheet's Apps Script project. */
  dumpUrl: string;
  /** Shared secret that the dump script checks; created once, never returned to the browser. */
  secret: string;
  /** Branch that old-Sheet classes belong to. */
  branchId: string;
  lastPullAt: string | null;
  lastPullError: string | null;
  lastPullCounts: Record<string, number> | null;
}

const KEY = 'sheetsync';

export async function getSheetSyncCfg(): Promise<SheetSyncCfg> {
  const row = await prisma.setting.findUnique({ where: { key: KEY } });
  return { writeOn: false, bridgeUrl: DEFAULT_BRIDGE_URL, pullOn: false, dumpUrl: '', secret: '', branchId: '', lastPullAt: null, lastPullError: null, lastPullCounts: null, ...((row?.value ?? {}) as Partial<SheetSyncCfg>) };
}

export async function saveSheetSyncCfg(cfg: SheetSyncCfg) {
  const value = cfg as unknown as Prisma.InputJsonValue;
  await prisma.setting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
}

export async function patchSheetSyncCfg(patch: Partial<SheetSyncCfg>) {
  const c = { ...(await getSheetSyncCfg()), ...patch };
  await saveSheetSyncCfg(c);
  return c;
}

export async function ensureSheetSecret(): Promise<SheetSyncCfg> {
  const c = await getSheetSyncCfg();
  if (c.secret) return c;
  return patchSheetSyncCfg({ secret: crypto.randomBytes(18).toString('base64url') });
}

export function publicSheetSyncCfg(c: SheetSyncCfg) {
  return {
    write_on: c.writeOn,
    bridge_url: c.bridgeUrl,
    pull_on: c.pullOn,
    dump_url: c.dumpUrl,
    branch_id: c.branchId,
    last_pull_at: c.lastPullAt,
    last_pull_error: c.lastPullError,
    last_pull_counts: c.lastPullCounts,
  };
}

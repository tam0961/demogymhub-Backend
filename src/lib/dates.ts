const VN_MS = 7 * 3600 * 1000;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const todayVN = (now = new Date()) => new Date(now.getTime() + VN_MS).toISOString().slice(0, 10);
export const dateOnly = (s: string) => new Date(`${s}T00:00:00Z`);
export const fmtDate = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);

export function dayRange(day: string) {
  const start = new Date(`${day}T00:00:00+07:00`);
  return { gte: start, lt: new Date(start.getTime() + 86400000) };
}

export const vnDayOf = (d: Date) => new Date(d.getTime() + VN_MS).toISOString().slice(0, 10);

import { fold } from './sheet-import';

export interface ShiftEntry {
  name: string;
  hours: string[];
  off: boolean;
}

export interface ParsedShift {
  date: string;
  entries: ShiftEntry[];
}

const VN_MS = 7 * 3600 * 1000;
const pad = (n: number) => String(n).padStart(2, '0');
const addDays = (iso: string, n: number) => new Date(new Date(`${iso}T12:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);

export const lastWord = (name: string) => fold(name.replace(/[^\p{L}\s]/gu, ' ')).split(' ').filter(Boolean).pop() ?? '';
export const fmtDM = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

function cleanName(raw: string) {
  const t = raw
    .replace(/[^\p{L}\s.]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(a|anh)\b\.?\s+/i, '');
  return t.trim();
}

function parseHours(rest: string): { off: boolean; hours: string[] } {
  const f = fold(rest);
  if (/\boff\b/.test(f) || f.includes('nghi')) return { off: true, hours: [] };
  const hours = new Set<string>();
  let s = f;
  const range = /(\d{1,2})(?:h(\d{2})?)?\s*-\s*(\d{1,2})(?:h(\d{2})?)?/g;
  for (const m of f.matchAll(range)) {
    const a = Number(m[1]);
    const b = Number(m[3]);
    const min = m[2] ?? '00';
    for (let h = a; h < b && h < 24; h++) hours.add(`${pad(h)}:${min}`);
    s = s.replace(m[0], ' ');
  }
  for (const m of s.matchAll(/(\d{1,2})h(\d{2})?/g)) {
    const h = Number(m[1]);
    if (h < 24) hours.add(`${pad(h)}:${m[2] ?? '00'}`);
  }
  return { off: false, hours: [...hours].sort() };
}

/**
 * Reads a PT shift message like "CA DẠY 27/10 / 1/ A Khánh : 16h 17h / 2/ Trang : 6h 7h 18h".
 * Returns null when the text has no "Name : hours" line. Dates without a title: sent from 12:00 counts for tomorrow.
 */
export function parseShiftMessage(text: string, sentAt: Date): ParsedShift | null {
  const vn = new Date(sentAt.getTime() + VN_MS);
  const today = vn.toISOString().slice(0, 10);
  const lines = text.split(/\r?\n/);
  const entries: ShiftEntry[] = [];
  let date: string | null = null;
  for (const line of lines) {
    const f = fold(line);
    if (f.includes('ca day') && !/[:：]/.test(line.replace(/\d{1,2}[:：]\d{2}/g, ''))) {
      const m = line.match(/(\d{1,2})\s*[\/.-]\s*(\d{1,2})(?:\s*[\/.-]\s*(\d{2,4}))?/);
      if (m) {
        const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : vn.getUTCFullYear();
        date = `${y}-${pad(Number(m[2]))}-${pad(Number(m[1]))}`;
      } else if (f.includes('ngay mai')) date = addDays(today, 1);
      else if (f.includes('hom nay')) date = today;
      continue;
    }
    const m = line.match(/^\s*(?:\d+\s*[\/.)]\s*)?([^:：]+?)\s*[:：]\s*(.+)$/);
    if (!m) continue;
    const name = cleanName(m[1]);
    if (!name || fold(name).includes('ca day')) continue;
    const { off, hours } = parseHours(m[2]);
    if (!off && hours.length === 0) continue;
    entries.push({ name, hours, off });
  }
  if (entries.length === 0) return null;
  if (!date) date = vn.getUTCHours() >= 12 ? addDays(today, 1) : today;
  return { date, entries };
}

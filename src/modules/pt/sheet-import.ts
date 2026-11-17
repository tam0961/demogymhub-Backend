export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('84') && digits.length === 11) return `0${digits.slice(2)}`;
  return digits.length === 9 ? `0${digits}` : digits;
}

export const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

export interface ClassLabel {
  start: string;
  end: string;
  muscleGroup: string | null;
}

const pad = (t: string) => (t.length === 4 ? `0${t}` : t);

/** Parses "T2 (24/11) - 6:30-7:45 (Core + Cardio)" (en dash or hyphen); returns null when the time range is missing. */
export function parseClassLabel(label: string): ClassLabel | null {
  const m = label.match(/(\d{1,2}:\d{2})\s*[–-]\s*(\d{1,2}:\d{2})\s*(?:\((.*)\))?/);
  if (!m) return null;
  return { start: pad(m[1]), end: pad(m[2]), muscleGroup: m[3]?.replace(/\s+,/g, ',').trim() || null };
}

export type RegStatus = 'booked' | 'attended' | 'cancelled';

export function mapStatus(raw: string): RegStatus | null {
  const s = fold(raw);
  if (!s) return null;
  if (s.includes('da hoc') || s.includes('attended')) return 'attended';
  if (s.includes('huy') || s.includes('cancel')) return 'cancelled';
  if (s.includes('da dat') || s.includes('dang ky') || s.includes('confirm') || s.includes('booked')) return 'booked';
  return null;
}

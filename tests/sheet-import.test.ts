import { describe, expect, it } from 'vitest';
import { mapStatus, normalizePhone, parseClassLabel, parseCsv } from '../src/modules/pt/sheet-import';

describe('group sheet import helpers', () => {
  it('parses class labels with en dash, single-digit hour and muscle group', () => {
    expect(parseClassLabel('T2 (24/11) – 6:30–7:45 (Core + Cardio)')).toEqual({ start: '06:30', end: '07:45', muscleGroup: 'Core + Cardio' });
    expect(parseClassLabel('T4 (26/11) – 20:00–21:15 (Lưng , Vai + Tay sau)')).toEqual({ start: '20:00', end: '21:15', muscleGroup: 'Lưng, Vai + Tay sau' });
    expect(parseClassLabel('khong co gio')).toBeNull();
  });
  it('restores the leading zero on phones', () => {
    expect(normalizePhone('906682737')).toBe('0906682737');
    expect(normalizePhone('0906 682 737')).toBe('0906682737');
    expect(normalizePhone('+84906682737')).toBe('0906682737');
  });
  it('maps statuses and leaves unknown ones null', () => {
    expect(mapStatus('Đã học')).toBe('attended');
    expect(mapStatus('Đã hủy')).toBe('cancelled');
    expect(mapStatus('Confirmed')).toBe('booked');
    expect(mapStatus('???')).toBeNull();
    expect(mapStatus('')).toBeNull();
  });
  it('parses quoted csv cells with commas and newlines', () => {
    expect(parseCsv('a,"b, c","d\ne"\n1,2,3\n')).toEqual([['a', 'b, c', 'd\ne'], ['1', '2', '3']]);
  });
});

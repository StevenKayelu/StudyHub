import { describe, expect, it } from 'vitest';

import { csvCell, parseCsv, toCsv } from '../../platform';
import { buildZip, readZip } from '../domain/zip';

describe('CSV (F32, W7)', () => {
  it('quotes separators, quotes and line breaks', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(12n)).toBe('12');
    expect(csvCell(null)).toBe('');
  });

  it('defuses spreadsheet formulas', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('-5')).toBe("'-5");
    expect(csvCell(-5)).toBe('-5');
  });

  it('round-trips through the parser', () => {
    const text = toCsv(
      ['a', 'b'],
      [
        ['x,y', 'line\nbreak'],
        ['1', ''],
      ],
    );
    expect(parseCsv(text)).toEqual([
      ['a', 'b'],
      ['x,y', 'line\nbreak'],
      ['1', ''],
    ]);
    expect(parseCsv('ref,amount\nA,100\n\nB,200')).toEqual([
      ['ref', 'amount'],
      ['A', '100'],
      ['B', '200'],
    ]);
  });
});

describe('ZIP (F46)', () => {
  it('writes entries that read back unchanged', () => {
    const archive = buildZip([
      { name: 'data/course.json', data: Buffer.from('[{"id":1}]') },
      { name: 'files/ünïcode.txt', data: Buffer.alloc(10_000, 7) },
    ]);
    expect(archive.readUInt32LE(0)).toBe(0x04034b50);
    const entries = readZip(archive);
    expect(entries.get('data/course.json')?.toString()).toBe('[{"id":1}]');
    expect(entries.get('files/ünïcode.txt')?.length).toBe(10_000);
  });
});

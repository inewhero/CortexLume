import { describe, expect, it } from 'vitest';
import { parseDigitizerFile } from './digitizerImport';

const bytes = (value: string) => new TextEncoder().encode(value);

describe('digitizer imports', () => {
  it('reads BIDS-style TSV optodes', () => {
    const imported = parseDigitizerFile('sub-01_optodes.tsv', bytes('name\ttype\tx\ty\tz\nNz\tlandmark\t0\t84\t-43\nIz\tlandmark\t0\t-114\t-30\nLPA\tlandmark\t-75\t-19\t-48\nRPA\tlandmark\t76\t-19\t-48\nCz\tlandmark\t0\t-12\t101\nS1\tsource\t-40\t20\t80'));
    expect(imported.points).toHaveLength(6);
    expect(imported.suggestedUnit).toBe('mm');
    expect(imported.points.at(-1)?.kind).toBe('source');
  });

  it('reads JSON point arrays', () => {
    const imported = parseDigitizerFile('points.json', bytes(JSON.stringify([
      { name: 'Nz', x: 0, y: .084, z: -.043 }, { name: 'Iz', x: 0, y: -.114, z: -.03 },
      { name: 'LPA', x: -.075, y: -.019, z: -.048 }, { name: 'RPA', x: .076, y: -.019, z: -.048 },
      { name: 'Cz', x: 0, y: -.012, z: .101 },
    ])));
    expect(imported.suggestedUnit).toBe('m');
  });

  it('rejects oversized lines and labels before producing points', () => {
    expect(() => parseDigitizerFile('points.tsv', bytes(`x\ty\tz\n${'1'.repeat(70_000)}`)))
      .toThrow(/excessively long line/);
    const json = JSON.stringify(Array.from({ length: 5 }, (_, index) => ({
      name: index === 0 ? 'L'.repeat(257) : `P${index}`, x: index, y: index, z: index,
    })));
    expect(() => parseDigitizerFile('points.json', bytes(json))).toThrow(/labels must not exceed/);
  });
});

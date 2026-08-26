import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseDigitizerFile } from './digitizerImport';

const fixture = (relative: string) => new URL(`../../../../examples/cases/${relative}`, import.meta.url);

describe('release example digitizer inputs', () => {
  it('imports the five-point TSV with recognized landmarks in millimetres', async () => {
    const fileName = 'five_points.tsv';
    const imported = parseDigitizerFile(fileName, new Uint8Array(await readFile(
      fixture(`03-digitizer-five-point/data/${fileName}`),
    )));
    expect(imported).toMatchObject({ format: 'TSV', suggestedUnit: 'mm' });
    expect(imported.points).toHaveLength(5);
    expect(imported.points.map((point) => point.label)).toEqual(['Nz', 'Iz', 'LPA', 'RPA', 'Cz']);
    expect(imported.points.every((point) => point.kind === 'landmark')).toBe(true);
  });

  it('imports the headerless MNE/Polhemus array in metres', async () => {
    const fileName = 'polhemus_full_array.eeg';
    const imported = parseDigitizerFile(fileName, new Uint8Array(await readFile(
      fixture(`04-digitizer-polhemus/data/${fileName}`),
    )));
    expect(imported).toMatchObject({ format: 'EEG', suggestedUnit: 'm' });
    expect(imported.points).toHaveLength(20);
    expect(imported.points.every((point) => point.kind === 'unknown')).toBe(true);
  });
});

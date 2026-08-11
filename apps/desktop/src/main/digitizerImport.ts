import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { DigitizerImport, DigitizerPoint, DigitizerPointKind } from '@cortexlume/contracts';

function splitDelimited(line: string, delimiter: string): string[] {
  if (delimiter === ' ') return line.trim().split(/\s+/);
  const values: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const character = line[i]!;
    if (character === '"') quoted = !quoted;
    else if (character === delimiter && !quoted) { values.push(current.trim()); current = ''; }
    else current += character;
  }
  values.push(current.trim());
  return values.map((value) => value.replace(/^"|"$/g, ''));
}

const key = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
const LABEL_KEYS = ['label', 'name', 'id', 'point', 'sample', 'samplename', 'electrode'];
const TYPE_KEYS = ['type', 'kind', 'category', 'pointtype'];
const AXIS_KEYS = {
  x: ['x', 'xmm', 'locx', 'locationx', 'positionx'],
  y: ['y', 'ymm', 'locy', 'locationy', 'positiony'],
  z: ['z', 'zmm', 'locz', 'locationz', 'positionz'],
};

function pointKind(type: string, label: string): DigitizerPointKind {
  const value = `${type} ${label}`.toLowerCase();
  if (/source|transmitter|^\s*s\d/.test(value)) return 'source';
  if (/detector|receiver|^\s*d\d/.test(value)) return 'detector';
  if (/nasion|inion|\bnz\b|\biz\b|\blpa\b|\brpa\b|\bcz\b|fiducial|landmark/.test(value)) return 'landmark';
  if (/headshape|hsp|scalp/.test(value)) return 'headshape';
  return 'unknown';
}

function parsedPoint(label: string, type: string, x: unknown, y: unknown, z: unknown): DigitizerPoint | null {
  const position = [Number(x), Number(y), Number(z)] as [number, number, number];
  if (!position.every(Number.isFinite)) return null;
  const safeLabel = String(label || `P${Math.random().toString(36).slice(2, 7)}`);
  return { id: randomUUID(), label: safeLabel, kind: pointKind(type, safeLabel), rawPosition: position };
}

function fromObjects(rows: Array<Record<string, unknown>>): DigitizerPoint[] {
  return rows.flatMap((row, index) => {
    const entries = new Map(Object.entries(row).map(([name, value]) => [key(name), value]));
    const find = (names: string[]) => names.map((name) => entries.get(name)).find((value) => value !== undefined);
    const point = parsedPoint(
      String(find(LABEL_KEYS) ?? `P${index + 1}`), String(find(TYPE_KEYS) ?? ''),
      find(AXIS_KEYS.x), find(AXIS_KEYS.y), find(AXIS_KEYS.z),
    );
    return point ? [point] : [];
  });
}

function parseText(text: string, extension: string): DigitizerPoint[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#') && !line.startsWith('%'));
  if (!lines.length) return [];
  const delimiter = lines[0]!.includes('\t') ? '\t' : lines[0]!.includes(',') ? ',' : lines[0]!.includes(';') ? ';' : ' ';
  const first = splitDelimited(lines[0]!, delimiter);
  const normalized = first.map(key);
  const xIndex = normalized.findIndex((name) => AXIS_KEYS.x.includes(name));
  const yIndex = normalized.findIndex((name) => AXIS_KEYS.y.includes(name));
  const zIndex = normalized.findIndex((name) => AXIS_KEYS.z.includes(name));
  const hasHeader = xIndex >= 0 && yIndex >= 0 && zIndex >= 0;
  if (hasHeader) {
    const labelIndex = normalized.findIndex((name) => LABEL_KEYS.includes(name));
    const typeIndex = normalized.findIndex((name) => TYPE_KEYS.includes(name));
    return lines.slice(1).flatMap((line, index) => {
      const values = splitDelimited(line, delimiter);
      const point = parsedPoint(labelIndex >= 0 ? values[labelIndex] ?? `P${index + 1}` : `P${index + 1}`, typeIndex >= 0 ? values[typeIndex] ?? '' : extension === '.hsp' ? 'headshape' : '', values[xIndex], values[yIndex], values[zIndex]);
      return point ? [point] : [];
    });
  }
  return lines.flatMap((line, index) => {
    const values = splitDelimited(line, delimiter);
    const numericStart = values.findIndex((value, itemIndex) => [value, values[itemIndex + 1], values[itemIndex + 2]].every((item) => Number.isFinite(Number(item))));
    if (numericStart < 0) return [];
    const label = numericStart > 0 ? values[0]! : `${extension === '.hsp' ? 'HSP' : 'P'}${String(index + 1).padStart(3, '0')}`;
    const point = parsedPoint(label, extension === '.hsp' ? 'headshape' : '', values[numericStart], values[numericStart + 1], values[numericStart + 2]);
    return point ? [point] : [];
  });
}

function suggestedUnit(points: DigitizerPoint[], text: string): 'mm' | 'cm' | 'm' {
  const unitMatch = text.match(/(?:units?|coordinateunits?)\s*[:=\t, ]+\s*(mm|cm|m)\b/i)?.[1]?.toLowerCase();
  if (unitMatch === 'm' || unitMatch === 'cm' || unitMatch === 'mm') return unitMatch;
  const maximum = Math.max(...points.flatMap((point) => point.rawPosition.map(Math.abs)));
  return maximum < 1 ? 'm' : maximum < 20 ? 'cm' : 'mm';
}

export function parseDigitizerFile(fileName: string, bytes: Uint8Array): DigitizerImport {
  const extension = path.extname(fileName).toLowerCase();
  const text = new TextDecoder().decode(bytes);
  let points: DigitizerPoint[] = [];
  if (extension === '.json') {
    const parsed = JSON.parse(text) as unknown;
    const rows = Array.isArray(parsed) ? parsed : typeof parsed === 'object' && parsed
      ? ((parsed as { points?: unknown[]; optodes?: unknown[] }).points ?? (parsed as { optodes?: unknown[] }).optodes ?? []) : [];
    points = fromObjects(rows.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object'));
  } else points = parseText(text, extension);
  if (points.length < 5) throw new Error('The selected file contains fewer than five readable 3D points.');
  return {
    fileName: path.basename(fileName), format: extension.slice(1).toUpperCase() || 'TEXT',
    sha256: createHash('sha256').update(bytes).digest('hex'), suggestedUnit: suggestedUnit(points, text), points,
  };
}

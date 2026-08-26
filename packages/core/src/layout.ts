import { createHash } from 'node:crypto';
import { LayoutDefinitionSchema, type LayoutDefinition, type OptodeType } from '@cortexlume/contracts';

function deterministicUuid(namespace: string, value: string): string {
  const hex = createHash('sha256').update(`${namespace}\0${value}`).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}

export interface GridPatchSpec {
  name?: string;
  columns?: number;
  rows?: number;
  pitchMm?: number;
  activeCells?: boolean[][];
  reverseSourceDetector?: boolean;
  shortChannelCount?: number;
}

export function createGridLayout(spec: GridPatchSpec, namespace: string, timestamp: string): LayoutDefinition {
  const columns = spec.columns ?? 5;
  const rows = spec.rows ?? 3;
  const pitchMm = spec.pitchMm ?? 30;
  if (!Number.isInteger(columns) || columns < 1 || columns > 12 || !Number.isInteger(rows) || rows < 1 || rows > 12) throw new Error('Patch rows and columns must be integers from 1 to 12.');
  if (!Number.isFinite(pitchMm) || pitchMm < 5 || pitchMm > 80) throw new Error('Patch pitch must be between 5 and 80 mm.');
  if (spec.activeCells && (spec.activeCells.length !== rows || spec.activeCells.some((row) => row.length !== columns))) throw new Error('activeCells must match patch rows and columns.');
  const shortChannelCount = spec.shortChannelCount ?? 0;
  if (!Number.isInteger(shortChannelCount) || shortChannelCount < 0) throw new Error('shortChannelCount must be a non-negative integer.');
  const layoutId = deterministicUuid(namespace, 'layout');
  const cells = new Map<string, LayoutDefinition['optodes'][number]>();
  const optodes: LayoutDefinition['optodes'] = [];
  let sourceCount = 0; let detectorCount = 0;
  for (let column = 0; column < columns; column += 1) for (let row = 0; row < rows; row += 1) {
    if (spec.activeCells && !spec.activeCells[row]![column]) continue;
    const normalSource = (row + column) % 2 === 0;
    const type: OptodeType = normalSource !== Boolean(spec.reverseSourceDetector) ? 'source' : 'detector';
    const count = type === 'source' ? ++sourceCount : ++detectorCount;
    const optode = {
      id: deterministicUuid(namespace, `optode:${column}:${row}`),
      label: `${type === 'source' ? 'S' : 'D'}${count}`,
      type,
      uvMm: [(column - (columns - 1) / 2) * pitchMm, ((rows - 1) / 2 - row) * pitchMm] as [number, number],
    };
    optodes.push(optode); cells.set(`${column}:${row}`, optode);
  }
  const pairs: LayoutDefinition['pairs'] = [];
  const addPair = (a: LayoutDefinition['optodes'][number] | undefined, b: LayoutDefinition['optodes'][number] | undefined, shortChannel = false) => {
    if (!a || !b || a.type === b.type) return;
    const source = a.type === 'source' ? a : b; const detector = a.type === 'detector' ? a : b;
    pairs.push({
      id: deterministicUuid(namespace, `pair:${a.id}:${b.id}`), sourceId: source.id, detectorId: detector.id,
      channelNumber: pairs.length + 1, nominalDistanceMm: Math.hypot(a.uvMm[0] - b.uvMm[0], a.uvMm[1] - b.uvMm[1]), shortChannel,
    });
  };
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns - 1; column += 1) addPair(cells.get(`${column}:${row}`), cells.get(`${column + 1}:${row}`));
    if (row < rows - 1) for (let column = 0; column < columns; column += 1) addPair(cells.get(`${column}:${row}`), cells.get(`${column}:${row + 1}`));
  }
  if (!optodes.some((optode) => optode.type === 'source')
    || !optodes.some((optode) => optode.type === 'detector')
    || pairs.length === 0) {
    throw new Error('Patch geometry must contain at least one connected long-channel source-detector pair.');
  }
  const sources = optodes.filter((optode) => optode.type === 'source');
  if (shortChannelCount > sources.length) throw new Error(`shortChannelCount exceeds the ${sources.length} available sources.`);
  for (let index = 0; index < shortChannelCount; index += 1) {
    const source = sources[index]!;
    const detector = {
      id: deterministicUuid(namespace, `short-detector:${source.id}`),
      label: `D${++detectorCount}`,
      type: 'detector' as const,
      uvMm: [source.uvMm[0] + 10, source.uvMm[1]] as [number, number],
    };
    optodes.push(detector);
    addPair(source, detector, true);
  }
  // LayoutDefinitionSchema is the shared graph-limit boundary for every
  // caller. Keep this assertion in the core constructor so a generated
  // layout can never escape with more optodes/pairs than a project can save.
  return LayoutDefinitionSchema.parse({
    id: layoutId, version: 1, name: spec.name?.trim() || 'Agent patch', createdAt: timestamp, updatedAt: timestamp,
    gridSpacingMm: pitchMm, optodes, pairs,
  });
}

export { deterministicUuid };

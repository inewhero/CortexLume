import { LayoutDefinitionSchema, type LayoutDefinition, type OptodeType } from '@cortexlume/contracts';

export const BUILTIN_PATCH_CATALOG_VERSION = 1 as const;
export const BUILTIN_PATCH_CATALOG_TIMESTAMP = '2000-01-01T00:00:00.000Z';

export const BUILTIN_PATCH_PRESET_IDS = [
  '1s4d-cross-30mm',
  'grid-2x2-30mm',
  'grid-3x3-30mm',
  'grid-3x5-30mm',
  'grid-4x4-30mm',
] as const;

export type BuiltinPatchPresetId = typeof BUILTIN_PATCH_PRESET_IDS[number];

export interface BuiltinPatchPreset {
  readonly id: BuiltinPatchPresetId;
  readonly version: 1;
  readonly title: string;
  readonly description: string;
  readonly rows: number | null;
  readonly columns: number | null;
  readonly pitchMm: 30;
  readonly layout: LayoutDefinition;
}

interface MutableLayoutSpec {
  name: string;
  optodes: Array<{ key: string; label: string; type: OptodeType; uvMm: [number, number] }>;
  pairKeys: Array<[string, string]>;
}

/** Small synchronous hash used only to make stable UUID-shaped graph IDs. */
function stableUuid(namespace: string, value: string): string {
  const input = `${namespace}\0${value}`;
  const states = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  for (let offset = 0; offset < states.length; offset += 1) {
    let state = states[offset]!;
    for (let index = 0; index < input.length; index += 1) {
      state ^= input.charCodeAt(index) + offset * 0x9d;
      state = Math.imul(state, 0x01000193);
      state ^= state >>> 13;
    }
    states[offset] = state >>> 0;
  }
  const hex = states.map((state) => state.toString(16).padStart(8, '0')).join('').split('');
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}

function gridSpec(rows: number, columns: number): MutableLayoutSpec {
  const optodes: MutableLayoutSpec['optodes'] = [];
  const pairKeys: MutableLayoutSpec['pairKeys'] = [];
  let sourceCount = 0;
  let detectorCount = 0;
  for (let column = 0; column < columns; column += 1) {
    for (let row = 0; row < rows; row += 1) {
      const type: OptodeType = (row + column) % 2 === 0 ? 'source' : 'detector';
      const count = type === 'source' ? ++sourceCount : ++detectorCount;
      optodes.push({
        key: `${column}:${row}`,
        label: `${type === 'source' ? 'S' : 'D'}${count}`,
        type,
        uvMm: [(column - (columns - 1) / 2) * 30, ((rows - 1) / 2 - row) * 30],
      });
    }
  }
  // Canonical channel order: each horizontal row, then its following vertical boundary.
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns - 1; column += 1) {
      pairKeys.push([`${column}:${row}`, `${column + 1}:${row}`]);
    }
    if (row < rows - 1) {
      for (let column = 0; column < columns; column += 1) {
        pairKeys.push([`${column}:${row}`, `${column}:${row + 1}`]);
      }
    }
  }
  return { name: `${rows}x${columns} grid 30 mm`, optodes, pairKeys };
}

function crossSpec(): MutableLayoutSpec {
  return {
    name: '1S4D cross 30 mm',
    optodes: [
      { key: 'center', label: 'S1', type: 'source', uvMm: [0, 0] },
      { key: 'north', label: 'D1', type: 'detector', uvMm: [0, 30] },
      { key: 'east', label: 'D2', type: 'detector', uvMm: [30, 0] },
      { key: 'south', label: 'D3', type: 'detector', uvMm: [0, -30] },
      { key: 'west', label: 'D4', type: 'detector', uvMm: [-30, 0] },
    ],
    pairKeys: [['center', 'north'], ['center', 'east'], ['center', 'south'], ['center', 'west']],
  };
}

function materializeLayout(
  presetId: BuiltinPatchPresetId,
  spec: MutableLayoutSpec,
  namespace: string,
  timestamp: string,
  name = spec.name,
): LayoutDefinition {
  const optodes = spec.optodes.map((optode) => ({
    id: stableUuid(namespace, `optode:${optode.key}`),
    label: optode.label,
    type: optode.type,
    uvMm: [...optode.uvMm] as [number, number],
  }));
  const optodeByKey = new Map(spec.optodes.map((optode, index) => [optode.key, optodes[index]!]));
  const pairs = spec.pairKeys.map(([leftKey, rightKey], index) => {
    const left = optodeByKey.get(leftKey)!;
    const right = optodeByKey.get(rightKey)!;
    const source = left.type === 'source' ? left : right;
    const detector = left.type === 'detector' ? left : right;
    return {
      id: stableUuid(namespace, `pair:${leftKey}:${rightKey}`),
      sourceId: source.id,
      detectorId: detector.id,
      channelNumber: index + 1,
      nominalDistanceMm: 30,
      shortChannel: false,
    };
  });
  return LayoutDefinitionSchema.parse({
    id: stableUuid(namespace, `layout:${presetId}`),
    version: 1,
    name,
    createdAt: timestamp,
    updatedAt: timestamp,
    gridSpacingMm: 30,
    optodes,
    pairs,
  });
}

const SPECS: Record<BuiltinPatchPresetId, MutableLayoutSpec> = {
  '1s4d-cross-30mm': crossSpec(),
  'grid-2x2-30mm': gridSpec(2, 2),
  'grid-3x3-30mm': gridSpec(3, 3),
  'grid-3x5-30mm': gridSpec(3, 5),
  'grid-4x4-30mm': gridSpec(4, 4),
};

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach((child) => deepFreeze(child));
  }
  return value;
}

export const BUILTIN_PATCH_PRESETS: readonly BuiltinPatchPreset[] = deepFreeze(
  BUILTIN_PATCH_PRESET_IDS.map((id): BuiltinPatchPreset => {
    const grid = /^grid-(\d+)x(\d+)-30mm$/.exec(id);
    const rows = grid ? Number(grid[1]) : null;
    const columns = grid ? Number(grid[2]) : null;
    return {
      id,
      version: 1,
      title: SPECS[id].name,
      description: id === '1s4d-cross-30mm'
        ? 'One central source with four orthogonal detectors at 30 mm.'
        : `${rows} rows by ${columns} columns, top-left source checkerboard with orthogonal nearest-neighbor channels.`,
      rows,
      columns,
      pitchMm: 30,
      layout: materializeLayout(id, SPECS[id], `cortexlume:builtin-patch:v1:${id}`, BUILTIN_PATCH_CATALOG_TIMESTAMP),
    };
  }),
);

export const BUILTIN_PATCH_LAYOUTS: readonly LayoutDefinition[] = deepFreeze(
  BUILTIN_PATCH_PRESETS.map((preset) => preset.layout),
);

const PRESETS_BY_ID = new Map(BUILTIN_PATCH_PRESETS.map((preset) => [preset.id, preset] as const));

export function isBuiltinPatchPresetId(value: unknown): value is BuiltinPatchPresetId {
  return typeof value === 'string' && PRESETS_BY_ID.has(value as BuiltinPatchPresetId);
}

export function getBuiltinPatchPreset(id: BuiltinPatchPresetId): BuiltinPatchPreset {
  return PRESETS_BY_ID.get(id)!;
}

export function instantiateBuiltinPatchLayout(
  id: BuiltinPatchPresetId,
  namespace: string,
  timestamp: string,
  options: { name?: string } = {},
): LayoutDefinition {
  const name = options.name?.trim() || SPECS[id].name;
  return materializeLayout(id, SPECS[id], namespace, timestamp, name);
}

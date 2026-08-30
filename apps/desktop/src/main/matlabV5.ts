/**
 * Narrow MATLAB Level-5 writer used for the AtlasViewer SD interchange file.
 *
 * This intentionally implements only the array classes needed by the SD
 * contract below: real double matrices, UTF-16 character rows, cell arrays,
 * and scalar structures. Keeping the surface small makes the binary contract
 * independently testable and avoids pretending to be a general MAT library.
 */

const MI_INT8 = 1;
const MI_UINT16 = 4;
const MI_INT32 = 5;
const MI_UINT32 = 6;
const MI_DOUBLE = 9;
const MI_MATRIX = 14;

const MX_CELL_CLASS = 1;
const MX_STRUCT_CLASS = 2;
const MX_CHAR_CLASS = 4;
const MX_DOUBLE_CLASS = 6;

export interface MatlabDoubleMatrix {
  kind: 'double';
  rows: number[][];
  columns: number;
}

export interface MatlabCharRow {
  kind: 'char';
  value: string;
}

export interface MatlabCellRow {
  kind: 'cell-row';
  values: MatlabValue[];
}

export interface MatlabStruct {
  kind: 'struct';
  fields: Record<string, MatlabValue>;
}

export type MatlabValue = MatlabDoubleMatrix | MatlabCharRow | MatlabCellRow | MatlabStruct;

export function matlabDouble(rows: number[][], columns?: number): MatlabDoubleMatrix {
  const resolvedColumns = columns ?? rows[0]?.length ?? 0;
  if (!Number.isInteger(resolvedColumns) || resolvedColumns < 0) {
    throw new Error('MAT double matrix column count must be a non-negative integer');
  }
  if (rows.some((row) => row.length !== resolvedColumns || row.some((value) => !Number.isFinite(value)))) {
    throw new Error('MAT double matrices must be rectangular and finite');
  }
  return { kind: 'double', rows, columns: resolvedColumns };
}

export const matlabChar = (value: string): MatlabCharRow => ({ kind: 'char', value });

export const matlabCellStrings = (values: string[]): MatlabCellRow => ({
  kind: 'cell-row',
  values: values.map(matlabChar),
});

export const matlabStruct = (fields: Record<string, MatlabValue>): MatlabStruct => ({ kind: 'struct', fields });

function alignedSize(size: number): number {
  return Math.ceil(size / 8) * 8;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function dataElement(type: number, payload: Uint8Array): Uint8Array {
  const output = new Uint8Array(8 + alignedSize(payload.byteLength));
  const view = new DataView(output.buffer);
  view.setUint32(0, type, true);
  view.setUint32(4, payload.byteLength, true);
  output.set(payload, 8);
  return output;
}

function uint32Payload(values: number[]): Uint8Array {
  const output = new Uint8Array(values.length * 4);
  const view = new DataView(output.buffer);
  values.forEach((value, index) => view.setUint32(index * 4, value, true));
  return output;
}

function int32Payload(values: number[]): Uint8Array {
  const output = new Uint8Array(values.length * 4);
  const view = new DataView(output.buffer);
  values.forEach((value, index) => view.setInt32(index * 4, value, true));
  return output;
}

function doublePayload(rows: number[][], columns: number): Uint8Array {
  const output = new Uint8Array(rows.length * columns * 8);
  const view = new DataView(output.buffer);
  let offset = 0;
  // MAT numeric arrays are column-major.
  for (let column = 0; column < columns; column += 1) {
    for (let row = 0; row < rows.length; row += 1) {
      view.setFloat64(offset, rows[row]![column]!, true);
      offset += 8;
    }
  }
  return output;
}

function utf16Payload(value: string): Uint8Array {
  const output = new Uint8Array(value.length * 2);
  const view = new DataView(output.buffer);
  for (let index = 0; index < value.length; index += 1) {
    view.setUint16(index * 2, value.charCodeAt(index), true);
  }
  return output;
}

function matrix(name: string, value: MatlabValue): Uint8Array {
  let classId: number;
  let dimensions: [number, number];
  let content: Uint8Array[];

  if (value.kind === 'double') {
    classId = MX_DOUBLE_CLASS;
    dimensions = [value.rows.length, value.columns];
    content = [dataElement(MI_DOUBLE, doublePayload(value.rows, value.columns))];
  } else if (value.kind === 'char') {
    classId = MX_CHAR_CLASS;
    dimensions = value.value.length === 0 ? [0, 0] : [1, value.value.length];
    content = [dataElement(MI_UINT16, utf16Payload(value.value))];
  } else if (value.kind === 'cell-row') {
    classId = MX_CELL_CLASS;
    dimensions = [1, value.values.length];
    content = value.values.map((item) => matrix('', item));
  } else {
    classId = MX_STRUCT_CLASS;
    dimensions = [1, 1];
    const entries = Object.entries(value.fields);
    for (const [field] of entries) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(field)) {
        throw new Error(`Unsupported MATLAB structure field name: ${field}`);
      }
    }
    const fieldNameLength = Math.max(1, ...entries.map(([field]) => field.length + 1));
    const fieldNames = new Uint8Array(fieldNameLength * entries.length);
    entries.forEach(([field], fieldIndex) => {
      fieldNames.set(new TextEncoder().encode(field), fieldIndex * fieldNameLength);
    });
    content = [
      dataElement(MI_INT32, int32Payload([fieldNameLength])),
      dataElement(MI_INT8, fieldNames),
      ...entries.map(([, item]) => matrix('', item)),
    ];
  }

  const payload = concat([
    dataElement(MI_UINT32, uint32Payload([classId, 0])),
    dataElement(MI_INT32, int32Payload(dimensions)),
    dataElement(MI_INT8, new TextEncoder().encode(name)),
    ...content,
  ]);
  return dataElement(MI_MATRIX, payload);
}

/** Write one or more named variables as an uncompressed little-endian MAT v5 file. */
export function writeMatlabV5(variables: Record<string, MatlabValue>): Uint8Array {
  const header = new Uint8Array(128);
  const description = new TextEncoder().encode('MATLAB 5.0 MAT-file, Created by CortexLume');
  header.fill(0x20, 0, 116);
  header.set(description.subarray(0, 116), 0);
  const headerView = new DataView(header.buffer);
  headerView.setUint16(124, 0x0100, true);
  header[126] = 0x49; // I
  header[127] = 0x4d; // M
  return concat([header, ...Object.entries(variables).map(([name, value]) => matrix(name, value))]);
}

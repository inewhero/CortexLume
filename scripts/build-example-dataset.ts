import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';
import {
  CortexLumeProjectSchema,
  type CortexLumeProject,
  type DigitizerPoint,
  type FunctionalTargetMap,
  type LayoutDefinition,
  type LayoutInstance,
  type Optode,
  type Vec2,
  type Vec3,
} from '../packages/contracts/src/index';
import {
  canonicalProjectBytes,
  readProjectArchiveDetailed,
  sha256Bytes,
} from '../packages/project-io/src/index';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLES = path.join(ROOT, 'examples');
const CASES = path.join(EXAMPLES, 'cases');
const RELEASE = path.join(ROOT, 'release');
const FIXED_TIME = '2026-08-26T00:00:00.000Z';
const packageOnly = process.argv.includes('--package-only');
const verifyOnly = process.argv.includes('--verify-only');
const version = JSON.parse(readFileSync(path.join(ROOT, 'apps/desktop/package.json'), 'utf8')).version as string;

const TEMPLATE = {
  id: 'MNI152NLin6Asym' as const,
  assetVersion: 'templateflow-c906e8d_cedalion-icbm152-26.5.1',
  coordinateConvention: 'RAS+' as const,
  units: 'mm' as const,
  verified: true,
  manifestSha256: '4e522c5a68e316f449dad1cd47c35f3c051951b0987d7f43eadc615b2cd7f46e',
  scalpMeshSha256: '28836d0d13d22ccbd16e039e28f49b2357c15fb398a2a9e630ef484d7a95f01d',
  cortexMeshSha256: 'e4c9033a515fd7693eb07fb80708509352b7f8044f860e690acf52cbc98119f1',
  atlasSha256: '8591df9e9b37df27748d5ae3c8ca0478201834bac8014950115ba46697c4f6d0',
};

function uuid(seed: string): string {
  const bytes = createHash('sha256').update(`cortexlume-example:${seed}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const distance = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function makeLayout(
  seed: string,
  name: string,
  columns: number,
  rows: number,
  pitchMm = 30,
  active: (column: number, row: number) => boolean = () => true,
): LayoutDefinition {
  const cells = new Map<string, Optode>();
  const optodes: Optode[] = [];
  let sources = 0;
  let detectors = 0;
  for (let column = 0; column < columns; column += 1) {
    for (let row = 0; row < rows; row += 1) {
      if (!active(column, row)) continue;
      const type = (column + row) % 2 === 0 ? 'source' : 'detector';
      const index = type === 'source' ? ++sources : ++detectors;
      const optode: Optode = {
        id: uuid(`${seed}:optode:${column}:${row}`),
        label: `${type === 'source' ? 'S' : 'D'}${index}`,
        type,
        uvMm: [
          (column - (columns - 1) / 2) * pitchMm,
          ((rows - 1) / 2 - row) * pitchMm,
        ],
      };
      cells.set(`${column}:${row}`, optode);
      optodes.push(optode);
    }
  }
  const pairs: LayoutDefinition['pairs'] = [];
  const connect = (a?: Optode, b?: Optode) => {
    if (!a || !b || a.type === b.type) return;
    const source = a.type === 'source' ? a : b;
    const detector = a.type === 'detector' ? a : b;
    pairs.push({
      id: uuid(`${seed}:pair:${pairs.length + 1}`),
      sourceId: source.id,
      detectorId: detector.id,
      channelNumber: pairs.length + 1,
      nominalDistanceMm: distance(a.uvMm, b.uvMm),
      shortChannel: false,
    });
  };
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns - 1; column += 1) {
      connect(cells.get(`${column}:${row}`), cells.get(`${column + 1}:${row}`));
    }
    if (row < rows - 1) {
      for (let column = 0; column < columns; column += 1) {
        connect(cells.get(`${column}:${row}`), cells.get(`${column}:${row + 1}`));
      }
    }
  }
  return {
    id: uuid(`${seed}:layout`), version: 1, name, createdAt: FIXED_TIME, updatedAt: FIXED_TIME,
    gridSpacingMm: pitchMm, optodes, pairs,
  };
}

function makeInstance(seed: string, layout: LayoutDefinition, anchor: Vec3, rotationRad = 0): LayoutInstance {
  return {
    id: uuid(`${seed}:instance`), definitionId: layout.id, anchorRasMm: anchor,
    rotationRad, mappingRotationRad: 0, visible: true, locked: true, overrides: [], pairDepthOverridesMm: {},
    digitizerPositions: [], derivedFromInstanceId: null, digitizerSessionId: null,
  };
}

function baseProject(seed: string, name: string, layouts: LayoutDefinition[], instances: LayoutInstance[]): CortexLumeProject {
  return {
    format: 'cortexlume-project', formatVersion: 3, id: uuid(`${seed}:project`), name,
    createdAt: FIXED_TIME, updatedAt: FIXED_TIME, template: TEMPLATE, layouts, instances,
    deviceProfile: {
      manufacturer: 'Shimadzu', model: 'LABNIRS', wavelengthsNm: [780, 805, 830],
      measurementType: 'NIRSCWAMPLITUDE', units: 'V', sourceType: 'LASER', detectorType: 'PMT',
      samplingFrequencyHz: null,
    },
    bidsSettings: { subjectLabel: '01', sessionLabel: '', taskLabel: 'layout', acquisitionLabel: '', runIndex: null },
    projectionSettings: { mode: 'scalp', defaultDepthMm: 25, atlasProbabilityThreshold: 0, optodeRadiusMm: 3.6 },
    verifiedResults: [], digitizerSessions: [], functionalTarget: null,
    surfaceOverlay: 'none', coverageRegion: null, planning: null,
  } as CortexLumeProject;
}

function writeText(relativePath: string, contents: string): void {
  const destination = path.join(EXAMPLES, relativePath);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, `${contents.trim()}\n`, 'utf8');
}

function writeProject(caseName: string, fileName: string, project: CortexLumeProject): void {
  const validated = CortexLumeProjectSchema.parse(project);
  const projectBytes = canonicalProjectBytes(validated);
  const manifest = strToU8(JSON.stringify({
    format: validated.format,
    formatVersion: 3,
    projectId: validated.id,
    projectName: validated.name,
    savedAt: FIXED_TIME,
    applicationVersion: version,
    projectSha256: sha256Bytes(projectBytes),
    template: validated.template,
  }, null, 2));
  const timestamp = new Date(FIXED_TIME);
  const archive = zipSync({
    'manifest.json': [manifest, { mtime: timestamp }],
    'project.json': [projectBytes, { mtime: timestamp }],
  }, { level: 6 });
  const restored = readProjectArchiveDetailed(archive);
  if (restored.project.id !== validated.id || restored.sourceFormatVersion !== 3) {
    throw new Error(`Project archive round-trip failed for ${fileName}`);
  }
  const destination = path.join(CASES, caseName, fileName);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, archive);
}

const FIVE_POINTS: Record<string, Vec3> = {
  Nz: [0, 84, -43], Iz: [0, -114, -30], LPA: [-75.09, -19.49, -47.98],
  RPA: [76, -19.45, -47.7], Cz: [-0.2107, -11.5944, 100.5705],
};

function exactCalibration(sourceUnit: 'mm' | 'm') {
  const unitScale = sourceUnit === 'm' ? 1000 : 1;
  return {
    method: 'five-point-similarity' as const, sourceUnit,
    matrix: [unitScale, 0, 0, 0, 0, unitScale, 0, 0, 0, 0, unitScale, 0, 0, 0, 0, 1],
    scale: unitScale, rmsResidualMm: 0, maxResidualMm: 0,
    residuals: Object.entries(FIVE_POINTS).map(([label, position]) => ({
      label, measuredRasMm: position, targetRasMm: position, residualMm: 0,
    })),
    calibratedAt: FIXED_TIME,
  };
}

function makeDigitizerPoint(seed: string, label: string, kind: DigitizerPoint['kind'], rawPosition: Vec3): DigitizerPoint {
  return { id: uuid(`${seed}:point:${label}`), label, kind, rawPosition };
}

function generateCases(): void {
  rmSync(EXAMPLES, { recursive: true, force: true });
  mkdirSync(CASES, { recursive: true });

  const defaultLayout = makeLayout('quick-start', 'default', 5, 3);
  const defaultInstance = makeInstance('quick-start', defaultLayout, [-52, -18, 76], 0.1);
  writeProject('01-quick-start', 'quick-start.cortexlume', baseProject(
    'quick-start', 'Quick start · left frontoparietal', [defaultLayout], [defaultInstance],
  ));
  writeText('cases/01-quick-start/data/layout-spec.json', JSON.stringify({
    columns: 5, rows: 3, pitchMm: 30, upperLeft: 'source', numbering: {
      optodes: 'top-to-bottom, then left-to-right', channels: 'left-to-right, then top-to-bottom',
    },
  }, null, 2));
  writeText('cases/01-quick-start/README.md', `
# Quick start

Open \`quick-start.cortexlume\`. A standard 5 × 3, 30 mm patch is already placed on the left frontoparietal scalp.

1. Rotate the head and inspect the scalp and cortex projections.
2. Switch **Scalp / Cortex**, then select an optode or channel to inspect its coordinates and atlas result.
3. Move or rotate P01, edit the 2D layout, and save a derived project.

\`data/layout-spec.json\` records the geometry and numbering convention used by the example.
  `);

  const irregularMask = new Set([
    '2:0', '3:0', '4:0',
    '1:1', '2:1', '3:1', '4:1', '5:1',
    '0:2', '1:2', '2:2', '3:2', '4:2', '5:2', '6:2',
    '0:3', '1:3', '2:3', '4:3', '5:3', '6:3',
    '0:4', '1:4', '5:4', '6:4',
  ]);
  const irregular = makeLayout('irregular', 'Asymmetric peri-Rolandic wing', 7, 5, 30, (column, row) => irregularMask.has(`${column}:${row}`));
  const irregularInstance = makeInstance('irregular', irregular, [54, -14, 70], -0.18);
  writeProject('02-irregular-patch', 'irregular-patch.cortexlume', baseProject(
    'irregular', 'Irregular patch · peri-Rolandic wing', [irregular], [irregularInstance],
  ));
  writeText('cases/02-irregular-patch/data/active-cell-mask.json', JSON.stringify({
    columns: 7, rows: 5, pitchMm: 30,
    activeCells: [...irregularMask].map((key) => key.split(':').map(Number)),
  }, null, 2));
  writeText('cases/02-irregular-patch/README.md', `
# Complex irregular patch

Open \`irregular-patch.cortexlume\` to inspect a 25-optode asymmetric layout built from an active-cell mask.

1. Expand **Channel Index** to inspect the generated adjacent S–D pairs.
2. Move individual optodes in **Optode Design** and regenerate channels if needed.
3. Store the edited definition in **Patch Library**, then load a second independent copy into 3D Align.

\`data/active-cell-mask.json\` is the machine-readable source geometry.
  `);

  const manualLayout = makeLayout('five-point', 'Five-point calibrated patch', 5, 3);
  const originalManual = makeInstance('five-point-original', manualLayout, [-48, 8, 78], 0);
  writeProject('03-digitizer-five-point', 'five-point-input.cortexlume', baseProject(
    'five-point-input', 'Five-point calibration · input', [manualLayout], [structuredClone(originalManual)],
  ));
  originalManual.visible = false;
  const manualSessionId = uuid('five-point:session');
  const manualPoints = Object.entries(FIVE_POINTS).map(([label, position]) => makeDigitizerPoint('five-point', label, 'landmark', position));
  const derivedManual: LayoutInstance = {
    ...makeInstance('five-point-derived', manualLayout, [-48, 8, 78], 0),
    derivedFromInstanceId: originalManual.id, digitizerSessionId: manualSessionId,
    fitQc: { converged: true, iterations: 1, meanAbsoluteErrorMm: 0, maxAbsoluteErrorMm: 0, flags: [] },
  };
  const manualProject = baseProject('five-point', 'Five-point calibration · manual entry', [manualLayout], [originalManual, derivedManual]);
  manualProject.digitizerSessions = [{
    id: manualSessionId, name: 'Manual five-point calibration', importedAt: FIXED_TIME,
    source: { format: 'TSV', fileName: 'five_points.tsv', sha256: null }, points: manualPoints,
    calibratedPoints: manualPoints.map((point) => ({ pointId: point.id, rasMm: point.rawPosition })),
    calibration: exactCalibration('mm'), optodeMappings: [], visible: true,
  }];
  const fivePointTsv = `name\ttype\tx\ty\tz\tunit\n${Object.entries(FIVE_POINTS).map(([label, p]) => `${label}\tlandmark\t${p.join('\t')}\tmm`).join('\n')}`;
  const fivePointPath = path.join(CASES, '03-digitizer-five-point', 'data', 'five_points.tsv');
  mkdirSync(path.dirname(fivePointPath), { recursive: true });
  writeFileSync(fivePointPath, `${fivePointTsv}\n`, 'utf8');
  manualProject.digitizerSessions[0]!.source.sha256 = sha256(readFileSync(fivePointPath));
  writeProject('03-digitizer-five-point', 'five-point-calibrated.cortexlume', manualProject);
  writeText('cases/03-digitizer-five-point/README.md', `
# Five-point calibration

This case demonstrates the interactive five-landmark workflow without a full optode digitization.

1. Open \`five-point-calibrated.cortexlume\` to inspect the completed result: the original P01 is hidden and its calibrated derivative is active.
2. To repeat the workflow, open \`five-point-input.cortexlume\`, choose **Info Panel → Workflow → 5-Point**, and enter the rows from \`data/five_points.tsv\` in millimetres.
3. Confirm the five landmarks and inspect the new patch saved to Patch Library.
  `);

  const polhemusLayout = makeLayout('polhemus', 'Polhemus full-array patch', 5, 3);
  const originalPolhemus = makeInstance('polhemus-original', polhemusLayout, [-58, 12, 72], 0.08);
  writeProject('04-digitizer-polhemus', 'polhemus-input.cortexlume', baseProject(
    'polhemus-input', 'Digitizer calibration · input', [polhemusLayout], [structuredClone(originalPolhemus)],
  ));
  originalPolhemus.visible = false;
  const polhemusSessionId = uuid('polhemus:session');
  const polhemusLandmarks = Object.entries(FIVE_POINTS).map(([label, p]) => makeDigitizerPoint(
    'polhemus', label, 'unknown', [p[0] / 1000, p[1] / 1000, p[2] / 1000],
  ));
  const scalpOptodePositions: Vec3[] = [
    [-66, 42, 63], [-58, 18, 80], [-50, -8, 86], [-42, -32, 78], [-34, -54, 65],
    [-75, 30, 42], [-70, 4, 60], [-62, -22, 68], [-52, -46, 59], [-42, -65, 43],
    [-80, 15, 18], [-78, -12, 35], [-70, -38, 43], [-58, -60, 34], [-44, -76, 17],
  ];
  const optodePoints = polhemusLayout.optodes.map((optode, index) => makeDigitizerPoint(
    'polhemus', optode.label, 'unknown', scalpOptodePositions[index]!.map((value) => value / 1000) as Vec3,
  ));
  const allPolhemusPoints = [...polhemusLandmarks, ...optodePoints];
  const derivedPolhemus: LayoutInstance = {
    ...makeInstance('polhemus-derived', polhemusLayout, [-58, 12, 72], 0.08),
    derivedFromInstanceId: originalPolhemus.id, digitizerSessionId: polhemusSessionId,
    digitizerPositions: polhemusLayout.optodes.map((optode, index) => ({
      optodeId: optode.id, digitizerPointId: optodePoints[index]!.id, scalpRasMm: scalpOptodePositions[index]!,
    })),
    fitQc: { converged: true, iterations: 1, meanAbsoluteErrorMm: 0, maxAbsoluteErrorMm: 0, flags: [] },
  };
  const polhemusData = allPolhemusPoints.map((point) => point.rawPosition.map((value) => value.toFixed(6)).join(' ')).join('\n');
  const polhemusPath = path.join(CASES, '04-digitizer-polhemus', 'data', 'polhemus_full_array.eeg');
  mkdirSync(path.dirname(polhemusPath), { recursive: true });
  writeFileSync(polhemusPath, `${polhemusData}\n`, 'utf8');
  const polhemusProject = baseProject('polhemus', 'Digitizer calibration · MNE Polhemus', [polhemusLayout], [originalPolhemus, derivedPolhemus]);
  polhemusProject.digitizerSessions = [{
    id: polhemusSessionId, name: 'MNE Polhemus full-array calibration', importedAt: FIXED_TIME,
    source: { format: 'EEG', fileName: path.basename(polhemusPath), sha256: sha256(readFileSync(polhemusPath)) },
    points: allPolhemusPoints,
    calibratedPoints: allPolhemusPoints.map((point) => ({
      pointId: point.id, rasMm: point.rawPosition.map((value) => value * 1000) as Vec3,
    })),
    calibration: exactCalibration('m'),
    optodeMappings: polhemusLayout.optodes.map((optode, index) => ({
      pointId: optodePoints[index]!.id, instanceId: derivedPolhemus.id, optodeId: optode.id, distanceMm: 0,
    })),
    visible: true,
  }];
  writeProject('04-digitizer-polhemus', 'polhemus-calibrated.cortexlume', polhemusProject);
  writeText('cases/04-digitizer-polhemus/README.md', `
# MNE / Polhemus full-array calibration

\`data/polhemus_full_array.eeg\` contains five fiducials followed by 15 optode points in metres.

1. Open \`polhemus-calibrated.cortexlume\` to inspect the completed correspondence and the derived digitizer patch.
2. To repeat the import, open \`polhemus-input.cortexlume\`, then choose **Info Panel → Workflow → Digitizer**.
3. Select the EEG file, assign the first five points to Nz, Iz, LPA, RPA and Cz, map the remaining 15 points to P01, refresh correspondence, and confirm.

The parser intentionally sees the headerless points as \`UNKNOWN\`, matching common Polhemus/MNE exports; correspondence is resolved geometrically.
  `);

  const niftiDirectory = path.join(CASES, '05-nifti-functional-target', 'data');
  mkdirSync(niftiDirectory, { recursive: true });
  const niftiPath = path.join(niftiDirectory, 'bilateral_visual_target_z.nii.gz');
  const mapPath = path.join(niftiDirectory, '.mapped-target.json');
  const venvPython = process.platform === 'win32'
    ? path.join(ROOT, '.venv', 'Scripts', 'python.exe')
    : path.join(ROOT, '.venv', 'bin', 'python');
  const python = statSafe(venvPython) ? venvPython : process.platform === 'win32' ? 'python' : 'python3';
  execFileSync(python, [path.join(ROOT, 'scripts', 'generate_example_nifti.py'), '--nifti', niftiPath, '--map-json', mapPath], {
    cwd: ROOT, stdio: 'inherit', env: { ...process.env, PYTHONPATH: path.join(ROOT, 'services', 'science') },
  });
  const functionalTarget = JSON.parse(readFileSync(mapPath, 'utf8')) as FunctionalTargetMap;
  rmSync(mapPath, { force: true });
  const niftiLayout = makeLayout('nifti', 'Visual cortex 5×3', 5, 3);
  const niftiInstance = makeInstance('nifti', niftiLayout, [0, -92, 48], 0);
  writeProject('05-nifti-functional-target', 'nifti-import-input.cortexlume', baseProject(
    'nifti-input', 'NIfTI target · input', [niftiLayout], [niftiInstance],
  ));
  const niftiProject = baseProject('nifti', 'NIfTI target · bilateral visual cortex', [niftiLayout], [niftiInstance]);
  niftiProject.functionalTarget = functionalTarget;
  niftiProject.surfaceOverlay = 'functional-target';
  writeProject('05-nifti-functional-target', 'nifti-visual-target.cortexlume', niftiProject);
  writeText('cases/05-nifti-functional-target/data/target-metadata.json', JSON.stringify({
    file: path.basename(niftiPath), declaredSpace: 'NeurosynthMNI152-2mm', statistic: 'continuous z statistic',
    affine: [[2, 0, 0, -90], [0, 2, 0, -126], [0, 0, 2, -72], [0, 0, 0, 1]],
    shape: [91, 109, 91], spatialUnits: 'mm', sha256: sha256(readFileSync(niftiPath)),
  }, null, 2));
  writeText('cases/05-nifti-functional-target/README.md', `
# NIfTI functional target

This case contains a continuous bilateral occipital z-statistic volume on the accepted legacy Neurosynth/FSL MNI152 2 mm grid.

1. Open \`nifti-visual-target.cortexlume\` to see the already mapped Functional Map layer on the Cedalion 25k surface.
2. Toggle **Info Panel → Anatomy Layers → Functional map** to compare the target with the anatomy.
3. To repeat validation, open \`nifti-import-input.cortexlume\`, choose **Info Panel → Workflow → NIfTI Map**, select \`data/bilateral_visual_target_z.nii.gz\`, and declare **Neurosynth MNI152 2 mm**.

The volume is synthetic tutorial data, not a biological result. \`data/target-metadata.json\` records its grid, affine and SHA-256.
  `);

  writeText('README.md', `
# CortexLume example dataset ${version}

These cases are optional companion data for CortexLume ${version}. They are released separately and are not bundled into the installer or portable application.

| Case | Purpose |
| --- | --- |
| 01-quick-start | Open a placed standard 5 × 3 patch and inspect projections. |
| 02-irregular-patch | Edit and reuse a complex active-cell-mask layout. |
| 03-digitizer-five-point | Inspect or repeat interactive five-point calibration. |
| 04-digitizer-polhemus | Import and match a full MNE/Polhemus digitizer array. |
| 05-nifti-functional-target | Validate and map a continuous NIfTI target volume. |

Each case is self-contained: read its small README first, then open the included \`.cortexlume\` project or repeat the workflow with the file under \`data/\`.
  `);
}

function statSafe(filePath: string): boolean {
  try { return statSync(filePath).isFile(); } catch { return false; }
}

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

function verifyExamples(): string[] {
  const caseDirectories = readdirSync(CASES, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (caseDirectories.length !== 5) throw new Error(`Expected 5 example cases, found ${caseDirectories.length}`);
  for (const entry of caseDirectories) {
    const directory = path.join(CASES, entry.name);
    if (!statSafe(path.join(directory, 'README.md'))) throw new Error(`${entry.name} has no README.md`);
    if (!statSync(path.join(directory, 'data')).isDirectory()) throw new Error(`${entry.name} has no data directory`);
    const projects = walk(directory).filter((file) => file.endsWith('.cortexlume'));
    if (projects.length === 0) throw new Error(`${entry.name} has no CortexLume project`);
    for (const projectPath of projects) readProjectArchiveDetailed(readFileSync(projectPath));
  }
  return walk(EXAMPLES).filter((file) => !file.endsWith('manifest.json'));
}

function writeDatasetManifest(files: string[]): void {
  const manifest = {
    format: 'cortexlume-example-dataset', version, generatedAt: FIXED_TIME,
    cases: 5,
    files: files.map((file) => ({
      path: path.relative(EXAMPLES, file).replaceAll('\\', '/'),
      bytes: statSync(file).size,
      sha256: sha256(readFileSync(file)),
    })).sort((a, b) => a.path.localeCompare(b.path)),
  };
  writeText('manifest.json', JSON.stringify(manifest, null, 2));
}

function packageExamples(): string {
  mkdirSync(RELEASE, { recursive: true });
  const bundleRoot = `CortexLume-${version}-examples`;
  const entries: Record<string, [Uint8Array, { mtime: Date }]> = {};
  const timestamp = new Date(FIXED_TIME);
  for (const file of walk(EXAMPLES)) {
    const relative = path.relative(EXAMPLES, file).replaceAll('\\', '/');
    entries[`${bundleRoot}/${relative}`] = [readFileSync(file), { mtime: timestamp }];
  }
  const output = path.join(RELEASE, `${bundleRoot}.zip`);
  writeFileSync(output, zipSync(entries, { level: 9 }));
  return output;
}

if (!packageOnly && !verifyOnly) generateCases();
let files = verifyExamples();
if (!verifyOnly) {
  writeDatasetManifest(files);
  files = verifyExamples();
  const output = packageExamples();
  console.log(`Built ${path.relative(ROOT, output)} (${statSync(output).size} bytes, ${files.length + 1} files).`);
} else {
  console.log(`Verified ${files.length} example files across 5 cases.`);
}

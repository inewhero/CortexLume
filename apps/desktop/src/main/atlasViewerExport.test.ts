import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DigitizerSession, Vec3 } from '@cortexlume/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { materializeProjectionSnapshot } from '../renderer/lib/projectionSnapshot';
import { clearSurfaceProjectors } from '../renderer/lib/geometry';
import { registerVerifiedTestSurfaceProjectors } from '../renderer/lib/testSurfaceProjectors';
import { useProjectStore } from '../renderer/store/projectStore';
import { buildAtlasViewerExport, buildAtlasViewerExportAsync } from './atlasViewerExport';

const FIVE_POINT_POSITIONS: Record<'Nz' | 'Iz' | 'LPA' | 'RPA' | 'Cz', Vec3> = {
  Nz: [0, 84, -43],
  Iz: [0, -114, -30],
  LPA: [-75.09, -19.49, -47.98],
  RPA: [76, -19.45, -47.7],
  Cz: [-0.2107, -11.5944, 100.5705],
};

function verifiedProject(instanceCount = 1) {
  useProjectStore.getState().newProject();
  const layoutId = useProjectStore.getState().activeLayoutId;
  for (let index = 0; index < instanceCount; index += 1) {
    useProjectStore.getState().placeLayout(layoutId);
  }
  return materializeProjectionSnapshot(structuredClone(useProjectStore.getState().project));
}

function withSharedFivePointSession(project: ReturnType<typeof verifiedProject>) {
  const labels = ['Nz', 'Iz', 'LPA', 'RPA', 'Cz'] as const;
  const pointIds = labels.map(() => crypto.randomUUID());
  const session: DigitizerSession = {
    id: crypto.randomUUID(),
    name: 'Shared five point fixture',
    importedAt: new Date().toISOString(),
    source: { format: 'TEST', fileName: 'five-points.tsv', sha256: 'a'.repeat(64) },
    points: labels.map((label, index) => ({
      id: pointIds[index]!, label, kind: 'landmark', rawPosition: FIVE_POINT_POSITIONS[label],
    })),
    calibratedPoints: labels.map((label, index) => ({
      pointId: pointIds[index]!, rasMm: FIVE_POINT_POSITIONS[label],
    })),
    calibration: {
      method: 'five-point-similarity', sourceUnit: 'mm',
      matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      scale: 1, rmsResidualMm: 0.4, maxResidualMm: 0.7,
      residuals: labels.map((label) => ({
        label,
        measuredRasMm: FIVE_POINT_POSITIONS[label],
        targetRasMm: FIVE_POINT_POSITIONS[label],
        residualMm: 0,
      })),
      calibratedAt: new Date().toISOString(),
    },
    optodeMappings: [],
    visible: true,
  };
  project.digitizerSessions.push(session);
  project.instances.forEach((instance) => { instance.digitizerSessionId = session.id; });
  return session;
}

describe('AtlasViewer SD export', () => {
  beforeEach(() => registerVerifiedTestSurfaceProjectors());

  it('writes a real MAT v5 SD struct that scipy independently reads', async () => {
    const project = verifiedProject();
    project.deviceProfile.wavelengthsNm = [760, 850];
    withSharedFivePointSession(project);
    const bundle = buildAtlasViewerExport(project);
    const bytes = bundle.files['cortexlume_atlasviewer.SD'];
    expect(bytes).toBeInstanceOf(Uint8Array);
    if (!(bytes instanceof Uint8Array)) throw new Error('expected binary SD export');
    expect(new TextDecoder().decode(bytes.subarray(0, 24))).toBe('MATLAB 5.0 MAT-file, Cre');
    expect(new TextDecoder().decode(bytes.subarray(126, 128))).toBe('IM');

    const noLandmarkBytes = buildAtlasViewerExport(verifiedProject())
      .files['cortexlume_atlasviewer.SD'];
    if (!(noLandmarkBytes instanceof Uint8Array)) throw new Error('expected binary SD export');

    const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
    const sciencePython = process.platform === 'win32'
      ? path.join(repositoryRoot, '.venv', 'Scripts', 'python.exe')
      : path.join(repositoryRoot, '.venv', 'bin', 'python');
    expect(existsSync(sciencePython), 'science venv is required for independent MAT validation').toBe(true);
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'cortexlume-atlasviewer-'));
    const sdPath = path.join(temporaryDirectory, 'fixture.SD');
    const noLandmarkSdPath = path.join(temporaryDirectory, 'fixture-no-landmarks.SD');
    try {
      await writeFile(sdPath, bytes);
      await writeFile(noLandmarkSdPath, noLandmarkBytes);
      const python = [
        'import json, sys',
        'import numpy as np',
        'from scipy.io import loadmat, whosmat',
        "data = loadmat(sys.argv[1], struct_as_record=False, squeeze_me=True)",
        "sd = data['SD']",
        "sd_without_landmarks = loadmat(sys.argv[2], struct_as_record=False, squeeze_me=True)['SD']",
        'landmarks = sd.Landmarks3D',
        'payload = {',
        "  'variables': sorted(k for k in data if not k.startswith('__')),",
        "  'whos': [[name, list(shape), kind] for name, shape, kind in whosmat(sys.argv[1])],",
        "  'spatialUnit': str(sd.SpatialUnit),",
        "  'lambda': np.atleast_1d(sd.Lambda).astype(float).tolist(),",
        "  'srcPos': np.atleast_2d(sd.SrcPos).astype(float).tolist(),",
        "  'detPos': np.atleast_2d(sd.DetPos).astype(float).tolist(),",
        "  'srcPos3D': np.atleast_2d(sd.SrcPos3D).astype(float).tolist(),",
        "  'detPos3D': np.atleast_2d(sd.DetPos3D).astype(float).tolist(),",
        "  'nSrcs': int(sd.nSrcs),",
        "  'nDets': int(sd.nDets),",
        "  'nDummys': int(sd.nDummys),",
        "  'measList': np.atleast_2d(sd.MeasList).astype(float).tolist(),",
        "  'measListAct': np.atleast_1d(sd.MeasListAct).astype(float).tolist(),",
        "  'landmarkLabels': [str(x) for x in np.atleast_1d(landmarks.labels).tolist()],",
        "  'landmarkPos': np.atleast_2d(landmarks.pos).astype(float).tolist(),",
        "  'emptyLandmarksSize': int(np.asarray(sd_without_landmarks.Landmarks3D).size),",
        '}',
        'print(json.dumps(payload))',
      ].join('\n');
      const output = execFileSync(sciencePython, ['-c', python, sdPath, noLandmarkSdPath], { encoding: 'utf8' });
      const parsed = JSON.parse(output) as {
        variables: string[];
        whos: Array<[string, number[], string]>;
        spatialUnit: string;
        lambda: number[];
        srcPos: number[][];
        detPos: number[][];
        srcPos3D: number[][];
        detPos3D: number[][];
        nSrcs: number;
        nDets: number;
        nDummys: number;
        measList: number[][];
        measListAct: number[];
        landmarkLabels: string[];
        landmarkPos: number[][];
        emptyLandmarksSize: number;
      };
      expect(parsed.variables).toEqual(['SD']);
      expect(parsed.whos).toEqual([['SD', [1, 1], 'struct']]);
      expect(parsed.spatialUnit).toBe('mm');
      expect(parsed.lambda).toEqual(project.deviceProfile.wavelengthsNm);
      expect(parsed.srcPos3D.length).toBeGreaterThan(0);
      expect(parsed.detPos3D.length).toBeGreaterThan(0);
      expect(parsed.srcPos).toEqual(parsed.srcPos3D);
      expect(parsed.detPos).toEqual(parsed.detPos3D);
      expect(parsed.nSrcs).toBe(parsed.srcPos3D.length);
      expect(parsed.nDets).toBe(parsed.detPos3D.length);
      expect(parsed.nDummys).toBe(0);
      expect(parsed.srcPos3D.every((row) => row.length === 3 && row.every(Number.isFinite))).toBe(true);
      expect(parsed.detPos3D.every((row) => row.length === 3 && row.every(Number.isFinite))).toBe(true);
      expect(parsed.measList.every((row) => row.length === 4 && row.every(Number.isInteger))).toBe(true);
      expect(parsed.measListAct).toEqual(parsed.measList.map(() => 1));
      const channelsPerWavelength = parsed.measList.length / parsed.lambda.length;
      expect(Number.isInteger(channelsPerWavelength)).toBe(true);
      expect(parsed.measList.map((row) => row[3])).toEqual(parsed.lambda.flatMap((_, wavelengthIndex) => (
        Array.from({ length: channelsPerWavelength }, () => wavelengthIndex + 1)
      )));
      expect(parsed.landmarkLabels).toEqual(['Nz', 'Iz', 'LPA', 'RPA', 'Cz']);
      expect(parsed.landmarkPos).toEqual(Object.values(FIVE_POINT_POSITIONS));
      expect(parsed.emptyLandmarksSize).toBe(0);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('assigns stable one-based source/detector and wavelength indices across instances', () => {
    const project = verifiedProject(2);
    project.deviceProfile.wavelengthsNm = [760, 850];
    const bundle = buildAtlasViewerExport(project);
    const sidecarText = bundle.files['cortexlume_atlasviewer.json'];
    expect(typeof sidecarText).toBe('string');
    const sidecar = JSON.parse(sidecarText as string) as {
      counts: { sources: number; detectors: number; channels: number; measurementRows: number };
      sourceIndex: Array<{ index: number }>;
      detectorIndex: Array<{ index: number }>;
      channels: Array<{ sourceIndex: number; detectorIndex: number }>;
      registration: { subjectRegistered: boolean; landmarks3DIncluded: boolean };
    };
    expect(sidecar.sourceIndex.map((item) => item.index)).toEqual(
      Array.from({ length: sidecar.counts.sources }, (_, index) => index + 1),
    );
    expect(sidecar.detectorIndex.map((item) => item.index)).toEqual(
      Array.from({ length: sidecar.counts.detectors }, (_, index) => index + 1),
    );
    expect(sidecar.channels.every((channel) => (
      channel.sourceIndex >= 1 && channel.sourceIndex <= sidecar.counts.sources
      && channel.detectorIndex >= 1 && channel.detectorIndex <= sidecar.counts.detectors
    ))).toBe(true);
    expect(sidecar.counts.measurementRows).toBe(sidecar.counts.channels * 2);
    expect(sidecar.registration).toEqual({ subjectRegistered: false, landmarks3DIncluded: false });
    expect(bundle.warnings.some((warning) => warning.includes('complete probe registration in AtlasViewer'))).toBe(true);
  });

  it('fails closed for incomplete scientific projection state', () => {
    const project = verifiedProject();
    project.verifiedResults[0] = { ...project.verifiedResults[0]!, scalpRasMm: null };
    expect(() => buildAtlasViewerExport(project)).toThrow(/no finite 3D scalp coordinate/);

    const provisional = verifiedProject();
    provisional.verifiedResults[0] = { ...provisional.verifiedResults[0]!, status: 'provisional' };
    expect(() => buildAtlasViewerExport(provisional)).toThrow(/missing a verified surface projection/);

    useProjectStore.getState().newProject();
    expect(() => buildAtlasViewerExport(structuredClone(useProjectStore.getState().project)))
      .toThrow(/at least one non-superseded 3D layout instance/);
  });

  it('honors cancellation before emitting binary output', async () => {
    const project = verifiedProject();
    const controller = new AbortController();
    controller.abort();
    await expect(buildAtlasViewerExportAsync(project, { signal: controller.signal }))
      .rejects.toThrow(/cancelled/);
  });

  it('still refuses to materialize export coordinates without registered mesh projectors', () => {
    useProjectStore.getState().newProject();
    useProjectStore.getState().placeLayout(useProjectStore.getState().activeLayoutId);
    clearSurfaceProjectors();
    expect(() => materializeProjectionSnapshot(structuredClone(useProjectStore.getState().project)))
      .toThrow(/Scientific projection unavailable/);
  });
});

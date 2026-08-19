import { create } from 'zustand';
import type {
  BidsSettings,
  AnatomicalCoverageAnalysis,
  AnatomicalCoverageSettings,
  CortexLumeProject,
  DeviceProfile,
  DigitizerSession,
  DigitizerOptodeMapping,
  FunctionalTargetMap,
  LayoutDefinition,
  LayoutInstance,
  OptodeType,
  ProjectionResult,
  Vec2,
  Vec3,
} from '@cortexlume/contracts';
import type { BidsField } from '../lib/bidsValidation';

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();

function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function createStarterLayout(): LayoutDefinition {
  const timestamp = now();
  const optodes: LayoutDefinition['optodes'] = [];
  const cells = new Map<string, LayoutDefinition['optodes'][number]>();
  let sourceCount = 0;
  let detectorCount = 0;
  // Optode identifiers scan down each column before advancing left-to-right.
  for (let column = 0; column < 5; column += 1) {
    for (let row = 0; row < 3; row += 1) {
      const type: OptodeType = (row + column) % 2 === 0 ? 'source' : 'detector';
      const count = type === 'source' ? ++sourceCount : ++detectorCount;
      const optode = {
        id: id(),
        label: `${type === 'source' ? 'S' : 'D'}${count}`,
        type,
        uvMm: [(column - 2) * 30, (1 - row) * 30],
      } satisfies LayoutDefinition['optodes'][number];
      optodes.push(optode);
      cells.set(`${column}:${row}`, optode);
    }
  }
  const pairs: LayoutDefinition['pairs'] = [];
  const addPair = (a: LayoutDefinition['optodes'][number], b: LayoutDefinition['optodes'][number]) => {
    const source = a.type === 'source' ? a : b;
    const detector = a.type === 'detector' ? a : b;
    pairs.push({
      id: id(), sourceId: source.id, detectorId: detector.id,
      channelNumber: pairs.length + 1, nominalDistanceMm: distance(a.uvMm, b.uvMm), shortChannel: false,
    });
  };
  // Channels scan left-to-right, then top-to-bottom: horizontal row,
  // vertical row boundary, then the next horizontal row.
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      addPair(cells.get(`${column}:${row}`)!, cells.get(`${column + 1}:${row}`)!);
    }
    if (row < 2) {
      for (let column = 0; column < 5; column += 1) {
        addPair(cells.get(`${column}:${row}`)!, cells.get(`${column}:${row + 1}`)!);
      }
    }
  }
  return {
    id: id(),
    version: 1,
    name: 'default',
    createdAt: timestamp,
    updatedAt: timestamp,
    gridSpacingMm: 30,
    optodes,
    pairs,
  };
}

function createProject(): CortexLumeProject {
  const layout = createStarterLayout();
  const timestamp = now();
  return {
    format: 'cortexlume-project',
    formatVersion: 1,
    id: id(),
    name: 'Untitled layout study',
    createdAt: timestamp,
    updatedAt: timestamp,
    template: {
      id: 'MNI152NLin6Asym',
      assetVersion: 'templateflow-c906e8d_cedalion-icbm152-26.5.1',
      coordinateConvention: 'RAS+',
      units: 'mm',
      verified: true,
      manifestSha256: '27ab30e8a6b3b6419937b26adbd930d32adfe26afbbf73795ea30505619abe42',
      scalpMeshSha256: '28836d0d13d22ccbd16e039e28f49b2357c15fb398a2a9e630ef484d7a95f01d',
      cortexMeshSha256: 'e4c9033a515fd7693eb07fb80708509352b7f8044f860e690acf52cbc98119f1',
      atlasSha256: '8591df9e9b37df27748d5ae3c8ca0478201834bac8014950115ba46697c4f6d0',
    },
    layouts: [layout],
    instances: [],
    deviceProfile: {
      manufacturer: 'Shimadzu',
      model: 'LABNIRS',
      wavelengthsNm: [780, 805, 830],
      measurementType: 'NIRSCWAMPLITUDE',
      units: 'V',
      sourceType: 'LASER',
      detectorType: 'PMT',
      samplingFrequencyHz: null,
    },
    bidsSettings: {
      subjectLabel: '01',
      sessionLabel: '',
      taskLabel: 'layout',
      acquisitionLabel: '',
      runIndex: null,
    },
    projectionSettings: {
      mode: 'scalp',
      defaultDepthMm: 25,
      pairDepthOverridesMm: {},
      atlasProbabilityThreshold: 0,
      optodeRadiusMm: 3.6,
    },
    verifiedResults: [],
    digitizerSessions: [],
  };
}

type EditorTool = 'select' | 'add-source' | 'add-detector';
type InstanceEditMode = 'group' | 'individual';

export interface AnatomyVisibility {
  scalp: boolean;
  grayMatter: boolean;
  whiteMatter: boolean;
  fivePoint: boolean;
  tenTen: boolean;
  pointLabels: boolean;
  channelLabels: boolean;
}

export interface AnatomyAppearance {
  grayMatter: { color: string; opacity: number };
  whiteMatter: { color: string; opacity: number };
}

export type AnatomicalCoverageMode = 'mosaic' | 'region';
export type AnatomicalCoverageStatus = 'idle' | 'loading' | 'ready' | 'error';

interface ProjectStore {
  project: CortexLumeProject;
  projectPath: string | null;
  activeLayoutId: string;
  library: LayoutDefinition[];
  editorTool: EditorTool;
  selectedOptodeId: string | null;
  selectedInstanceId: string | null;
  selectedHeadOptodeId: string | null;
  selectedHeadPairId: string | null;
  instanceEditMode: InstanceEditMode;
  anatomyVisibility: AnatomyVisibility;
  anatomyAppearance: AnatomyAppearance;
  projectRevision: number;
  pastLayouts: LayoutDefinition[];
  futureLayouts: LayoutDefinition[];
  toast: string | null;
  bidsSettingsExpanded: boolean;
  bidsValidationFields: BidsField[];
  activeDigitizerSessionId: string | null;
  digitizerPreview: { session: DigitizerSession; mappings: DigitizerOptodeMapping[] } | null;
  functionalTarget: FunctionalTargetMap | null;
  anatomicalCoverage: AnatomicalCoverageAnalysis | null;
  anatomicalCoverageEnabled: boolean;
  anatomicalCoverageMode: AnatomicalCoverageMode;
  selectedCoverageRegionIndex: number | null;
  anatomicalCoverageSettings: AnatomicalCoverageSettings;
  anatomicalCoverageStatus: AnatomicalCoverageStatus;
  anatomicalCoverageError: string | null;
  setToast(message: string | null): void;
  setBidsSettingsExpanded(expanded: boolean, validationFields?: BidsField[]): void;
  addDigitizerSession(session: DigitizerSession): void;
  confirmDigitizerMapping(session: DigitizerSession, mappings: DigitizerOptodeMapping[]): void;
  confirmFivePointCalibration(session: DigitizerSession, targetInstanceIds: string[]): void;
  setDigitizerPreview(preview: { session: DigitizerSession; mappings: DigitizerOptodeMapping[] } | null): void;
  setFunctionalTarget(target: FunctionalTargetMap | null): void;
  setAnatomicalCoverageEnabled(enabled: boolean): void;
  setAnatomicalCoverageResult(result: AnatomicalCoverageAnalysis | null): void;
  setAnatomicalCoverageMode(mode: AnatomicalCoverageMode): void;
  setSelectedCoverageRegion(regionIndex: number | null): void;
  setAnatomicalCoverageStatus(status: AnatomicalCoverageStatus, error?: string | null): void;
  removeDigitizerSession(sessionId: string): void;
  toggleDigitizerSession(sessionId: string): void;
  setActiveDigitizerSession(sessionId: string | null): void;
  newProject(): void;
  loadProject(project: CortexLumeProject): void;
  setProjectPath(path: string | null): void;
  setProjectName(name: string): void;
  setDeviceProfile(profile: Partial<DeviceProfile>): void;
  setBidsSettings(settings: Partial<BidsSettings>): void;
  renameActiveLayout(name: string): void;
  setEditorTool(tool: EditorTool): void;
  selectOptode(optodeId: string | null): void;
  addOptode(type: OptodeType, uvMm: Vec2): void;
  moveOptode(optodeId: string, uvMm: Vec2): void;
  deleteSelectedOptode(): void;
  generateGrid(columns: number, rows: number, pitchMm: number): void;
  reverseOptodeTypes(): void;
  generatePairs(minMm: number, maxMm: number): void;
  updatePairChannelNumber(pairId: string, channelNumber: number): void;
  undoLayout(): void;
  redoLayout(): void;
  saveLayoutToLibrary(): void;
  placeLayout(layoutId: string, anchorRasMm?: Vec3): string | null;
  selectInstance(instanceId: string | null, optodeId?: string | null): void;
  selectChannel(instanceId: string, pairId: string): void;
  setInstanceEditMode(mode: InstanceEditMode): void;
  updateInstanceAnchor(instanceId: string, anchorRasMm: Vec3): void;
  rotateInstance(instanceId: string, deltaRad: number): void;
  rotateMapping(instanceId: string, deltaRad: number): void;
  toggleInstanceVisibility(instanceId: string): void;
  removeInstance(instanceId: string): void;
  updateInstanceOverride(instanceId: string, optodeId: string, uvMm: Vec2): void;
  resetInstanceOverride(instanceId: string, optodeId: string): void;
  commitPlacement(instance: LayoutInstance, projections: ProjectionResult[]): void;
  setProjectionMode(mode: 'scalp' | 'cortex'): void;
  setOptodeRadius(radiusMm: number): void;
  setDefaultDepth(depth: number | null): void;
  setAnatomyLayer(layer: keyof AnatomyVisibility, visible: boolean): void;
  setAnatomyAppearance(layer: keyof AnatomyAppearance, appearance: Partial<AnatomyAppearance[keyof AnatomyAppearance]>): void;
}

function updatePairDistances(layout: LayoutDefinition): LayoutDefinition {
  const byId = new Map(layout.optodes.map((optode) => [optode.id, optode]));
  return {
    ...layout,
    updatedAt: now(),
    pairs: layout.pairs.flatMap((pair) => {
      const source = byId.get(pair.sourceId);
      const detector = byId.get(pair.detectorId);
      if (!source || !detector) return [];
      return [{ ...pair, nominalDistanceMm: distance(source.uvMm, detector.uvMm) }];
    }),
  };
}

export const useProjectStore = create<ProjectStore>((set, get) => {
  const initialProject = createProject();

  const mutateActiveLayout = (mutator: (layout: LayoutDefinition) => LayoutDefinition) => {
    set((state) => {
      const current = state.project.layouts.find((layout) => layout.id === state.activeLayoutId);
      if (!current) return state;
      const nextLayout = updatePairDistances(mutator(current));
      return {
        project: {
          ...state.project,
          updatedAt: now(),
          layouts: state.project.layouts.map((layout) => layout.id === current.id ? nextLayout : layout),
          verifiedResults: [],
        },
        pastLayouts: [...state.pastLayouts.slice(-49), current],
        futureLayouts: [],
        projectRevision: state.projectRevision + 1,
      };
    });
  };

  return {
    project: initialProject,
    projectPath: null,
    activeLayoutId: initialProject.layouts[0]!.id,
    library: [structuredClone(initialProject.layouts[0]!)],
    editorTool: 'select',
    selectedOptodeId: null,
    selectedInstanceId: null,
    selectedHeadOptodeId: null,
    selectedHeadPairId: null,
    instanceEditMode: 'group',
    anatomyVisibility: {
      scalp: true,
      grayMatter: true,
      whiteMatter: false,
      fivePoint: true,
      tenTen: true,
      pointLabels: false,
      channelLabels: true,
    },
    anatomyAppearance: {
      grayMatter: { color: '#e3e3e3', opacity: 1 },
      whiteMatter: { color: '#fffbf0', opacity: 1 },
    },
    projectRevision: 0,
    pastLayouts: [],
    futureLayouts: [],
    toast: null,
    bidsSettingsExpanded: false,
    bidsValidationFields: [],
    activeDigitizerSessionId: null,
    digitizerPreview: null,
    functionalTarget: null,
    anatomicalCoverage: null,
    anatomicalCoverageEnabled: false,
    anatomicalCoverageMode: 'mosaic',
    selectedCoverageRegionIndex: null,
    anatomicalCoverageSettings: {
      kernelSigmaMm: 12,
      supportRadiusMm: 24,
      minimumAtlasMembership: 0.05,
    },
    anatomicalCoverageStatus: 'idle',
    anatomicalCoverageError: null,

    setToast: (toast) => set({ toast }),
    setBidsSettingsExpanded: (bidsSettingsExpanded, bidsValidationFields = []) => set({
      bidsSettingsExpanded,
      bidsValidationFields,
    }),
    addDigitizerSession: (session) => set((state) => ({
      project: { ...state.project, updatedAt: now(), digitizerSessions: [...state.project.digitizerSessions, session] },
      activeDigitizerSessionId: session.id,
    })),
    setDigitizerPreview: (digitizerPreview) => set({ digitizerPreview }),
    setFunctionalTarget: (functionalTarget) => set({
      functionalTarget,
      ...(functionalTarget ? {
        anatomicalCoverageEnabled: false,
        anatomicalCoverageStatus: 'idle' as const,
        anatomicalCoverageError: null,
      } : {}),
    }),
    setAnatomicalCoverageEnabled: (anatomicalCoverageEnabled) => set({
      anatomicalCoverageEnabled,
      ...(anatomicalCoverageEnabled ? { functionalTarget: null } : {}),
      anatomicalCoverageStatus: anatomicalCoverageEnabled ? 'loading' : 'idle',
      anatomicalCoverageError: null,
    }),
    setAnatomicalCoverageResult: (anatomicalCoverage) => set((state) => ({
      anatomicalCoverage,
      anatomicalCoverageStatus: anatomicalCoverage ? 'ready' : 'idle',
      anatomicalCoverageError: null,
      selectedCoverageRegionIndex: state.selectedCoverageRegionIndex != null
        && anatomicalCoverage?.regions.some((region) => region.regionIndex === state.selectedCoverageRegionIndex)
        ? state.selectedCoverageRegionIndex
        : null,
    })),
    setAnatomicalCoverageMode: (anatomicalCoverageMode) => set({ anatomicalCoverageMode }),
    setSelectedCoverageRegion: (selectedCoverageRegionIndex) => set({
      selectedCoverageRegionIndex,
      anatomicalCoverageMode: selectedCoverageRegionIndex == null ? 'mosaic' : 'region',
    }),
    setAnatomicalCoverageStatus: (anatomicalCoverageStatus, anatomicalCoverageError = null) => set({
      anatomicalCoverageStatus,
      anatomicalCoverageError,
    }),
    confirmDigitizerMapping: (session, mappings) => set((state) => {
      const pointPositions = new Map(session.calibratedPoints.map((point) => [point.pointId, point.rasMm]));
      const affected = new Set(mappings.map((mapping) => mapping.instanceId));
      const clones = state.project.instances.flatMap((original) => {
        if (!affected.has(original.id)) return [];
        const sourceLayout = state.project.layouts.find((layout) => layout.id === original.definitionId);
        if (!sourceLayout) return [];
        const instanceId = id();
        const layoutId = id();
        const clonedLayout: LayoutDefinition = {
          ...structuredClone(sourceLayout), id: layoutId,
          name: `${sourceLayout.name}D`, updatedAt: now(),
        };
        const remapped = mappings.filter((mapping) => mapping.instanceId === original.id).map((mapping) => ({ ...mapping, instanceId }));
        const instance: LayoutInstance = {
          ...structuredClone(original), id: instanceId, definitionId: layoutId, visible: true,
          digitizerPositions: remapped.map((mapping) => ({ optodeId: mapping.optodeId, digitizerPointId: mapping.pointId, scalpRasMm: pointPositions.get(mapping.pointId)! })),
          derivedFromInstanceId: original.id, digitizerSessionId: session.id, fitQc: undefined,
        };
        return [{ original, layout: clonedLayout, instance, mappings: remapped }];
      });
      const confirmedMappings = clones.flatMap((clone) => clone.mappings);
      return {
        project: {
          ...state.project,
          updatedAt: now(),
          digitizerSessions: [...state.project.digitizerSessions, { ...session, optodeMappings: confirmedMappings }],
          layouts: [...state.project.layouts, ...clones.map((clone) => clone.layout)],
          instances: [
            ...state.project.instances.map((instance) => affected.has(instance.id) ? { ...instance, visible: false } : instance),
            ...clones.map((clone) => clone.instance),
          ],
          verifiedResults: state.project.verifiedResults.filter((result) => !result.instanceId || !affected.has(result.instanceId)),
        },
        library: [...state.library, ...clones.map((clone) => structuredClone(clone.layout))],
        selectedInstanceId: clones[0]?.instance.id ?? state.selectedInstanceId,
        activeDigitizerSessionId: session.id,
        digitizerPreview: null,
        functionalTarget: null,
        anatomicalCoverage: null,
        anatomicalCoverageEnabled: false,
        anatomicalCoverageMode: 'mosaic',
        selectedCoverageRegionIndex: null,
        anatomicalCoverageStatus: 'idle',
        anatomicalCoverageError: null,
        projectRevision: state.projectRevision + 1,
      };
    }),
    confirmFivePointCalibration: (session, targetInstanceIds) => set((state) => {
      const affected = new Set(targetInstanceIds);
      const clones = state.project.instances.flatMap((original) => {
        if (!affected.has(original.id)) return [];
        const sourceLayout = state.project.layouts.find((layout) => layout.id === original.definitionId);
        if (!sourceLayout) return [];
        const layout: LayoutDefinition = {
          ...structuredClone(sourceLayout), id: id(),
          name: `${sourceLayout.name.replace(/\s+P\d+$/i, '')} five-point`, updatedAt: now(),
        };
        const instance: LayoutInstance = {
          ...structuredClone(original), id: id(), definitionId: layout.id, visible: true,
          digitizerPositions: [], derivedFromInstanceId: original.id, digitizerSessionId: session.id, fitQc: undefined,
        };
        return [{ layout, instance }];
      });
      return {
        project: {
          ...state.project, updatedAt: now(), digitizerSessions: [...state.project.digitizerSessions, session],
          layouts: [...state.project.layouts, ...clones.map((clone) => clone.layout)],
          instances: [...state.project.instances.map((instance) => affected.has(instance.id) ? { ...instance, visible: false } : instance), ...clones.map((clone) => clone.instance)],
        },
        library: [...state.library, ...clones.map((clone) => structuredClone(clone.layout))],
        selectedInstanceId: clones[0]?.instance.id ?? state.selectedInstanceId,
        activeDigitizerSessionId: session.id,
        projectRevision: state.projectRevision + 1,
      };
    }),
    removeDigitizerSession: (sessionId) => set((state) => {
      const removed = state.project.digitizerSessions.find((session) => session.id === sessionId);
      const pointIds = new Set(removed?.calibratedPoints.map((point) => point.pointId) ?? []);
      const derived = state.project.instances.filter((instance) => instance.digitizerSessionId === sessionId);
      const derivedIds = new Set(derived.map((instance) => instance.id));
      const derivedLayoutIds = new Set(derived.map((instance) => instance.definitionId));
      const originalIds = new Set(derived.flatMap((instance) => instance.derivedFromInstanceId ? [instance.derivedFromInstanceId] : []));
      return {
      project: {
        ...state.project,
        updatedAt: now(),
        digitizerSessions: state.project.digitizerSessions.filter((session) => session.id !== sessionId),
        layouts: state.project.layouts.filter((layout) => !derivedLayoutIds.has(layout.id)),
        instances: state.project.instances.filter((instance) => !derivedIds.has(instance.id)).map((instance) => originalIds.has(instance.id) ? { ...instance, visible: true } : { ...instance, digitizerPositions: (instance.digitizerPositions ?? []).filter((position) => !pointIds.has(position.digitizerPointId)) }),
        verifiedResults: state.project.verifiedResults.filter((result) => !result.instanceId || !derivedIds.has(result.instanceId)),
      },
      library: state.library.filter((layout) => !derivedLayoutIds.has(layout.id)),
      activeDigitizerSessionId: state.activeDigitizerSessionId === sessionId
        ? state.project.digitizerSessions.find((session) => session.id !== sessionId)?.id ?? null
        : state.activeDigitizerSessionId,
      selectedInstanceId: derivedIds.has(state.selectedInstanceId ?? '') ? [...originalIds][0] ?? null : state.selectedInstanceId,
      projectRevision: state.projectRevision + (derived.length ? 1 : 0),
    }; }),
    toggleDigitizerSession: (sessionId) => set((state) => ({
      project: { ...state.project, digitizerSessions: state.project.digitizerSessions.map((session) => session.id === sessionId ? { ...session, visible: !session.visible } : session) },
    })),
    setActiveDigitizerSession: (activeDigitizerSessionId) => set({ activeDigitizerSessionId }),
    newProject: () => {
      const project = createProject();
      set({
        project,
        projectPath: null,
        activeLayoutId: project.layouts[0]!.id,
        library: [structuredClone(project.layouts[0]!)],
        selectedOptodeId: null,
        selectedInstanceId: null,
        selectedHeadOptodeId: null,
        selectedHeadPairId: null,
        instanceEditMode: 'group',
        projectRevision: 0,
        pastLayouts: [],
        futureLayouts: [],
        bidsSettingsExpanded: false,
        bidsValidationFields: [],
        activeDigitizerSessionId: null,
        digitizerPreview: null,
        functionalTarget: null,
      });
    },
    loadProject: (project) => set(() => {
      const hydrated: CortexLumeProject = {
        ...structuredClone(project),
        instances: project.instances.map((instance) => ({
          ...structuredClone(instance),
          visible: instance.visible ?? true,
        })),
      };
      const referencedLayoutIds = new Set(hydrated.instances.map((instance) => instance.definitionId));
      const calibratedLayoutIds = new Set(hydrated.instances.flatMap((instance) =>
        instance.digitizerSessionId ? [instance.definitionId] : []));
      const reusableLayouts = hydrated.layouts.filter((layout) =>
        !referencedLayoutIds.has(layout.id) || calibratedLayoutIds.has(layout.id));
      const library = (reusableLayouts.length > 0 ? reusableLayouts : hydrated.layouts)
        .map((layout) => structuredClone(layout));
      return {
        project: hydrated,
        activeLayoutId: library[0]?.id ?? hydrated.layouts[0]?.id ?? '',
        library,
        selectedOptodeId: null,
        selectedInstanceId: hydrated.instances[0]?.id ?? null,
        selectedHeadOptodeId: null,
        selectedHeadPairId: null,
        instanceEditMode: 'group',
        projectRevision: 0,
        pastLayouts: [],
        futureLayouts: [],
        bidsSettingsExpanded: false,
        bidsValidationFields: [],
        activeDigitizerSessionId: hydrated.digitizerSessions.at(-1)?.id ?? null,
        digitizerPreview: null,
        functionalTarget: null,
        anatomicalCoverage: null,
        anatomicalCoverageEnabled: false,
        anatomicalCoverageMode: 'mosaic',
        selectedCoverageRegionIndex: null,
        anatomicalCoverageStatus: 'idle',
        anatomicalCoverageError: null,
      };
    }),
    setProjectPath: (projectPath) => set({ projectPath }),
    setProjectName: (name) => set((state) => ({
      project: { ...state.project, name, updatedAt: now() },
    })),
    setDeviceProfile: (profile) => set((state) => ({
      project: {
        ...state.project,
        updatedAt: now(),
        deviceProfile: { ...state.project.deviceProfile, ...profile },
      },
    })),
    setBidsSettings: (settings) => set((state) => ({
      project: {
        ...state.project,
        updatedAt: now(),
        bidsSettings: { ...state.project.bidsSettings, ...settings },
      },
    })),
    renameActiveLayout: (name) => {
      const normalized = name.trim();
      if (!normalized) {
        set({ toast: 'Layout name cannot be empty.' });
        return;
      }
      set((state) => {
        const current = state.project.layouts.find((layout) => layout.id === state.activeLayoutId);
        if (!current || current.name === normalized) return state;
        const renamed = { ...current, name: normalized, updatedAt: now() };
        return {
          project: {
            ...state.project,
            updatedAt: now(),
            layouts: state.project.layouts.map((layout) => layout.id === current.id ? renamed : layout),
          },
          library: state.library.map((layout) => layout.id === current.id
            ? structuredClone(renamed)
            : layout),
          pastLayouts: [...state.pastLayouts.slice(-49), current],
          futureLayouts: [],
          projectRevision: state.projectRevision + 1,
        };
      });
    },
    setEditorTool: (editorTool) => set({ editorTool }),
    selectOptode: (selectedOptodeId) => set({ selectedOptodeId }),

    addOptode: (type, uvMm) => {
      const state = get();
      const layout = state.project.layouts.find((item) => item.id === state.activeLayoutId);
      if (!layout || layout.optodes.length >= 100) {
        set({ toast: 'The layout limit is 100 optodes.' });
        return;
      }
      const count = layout.optodes.filter((optode) => optode.type === type).length + 1;
      const optodeId = id();
      mutateActiveLayout((value) => ({
        ...value,
        optodes: [...value.optodes, { id: optodeId, label: `${type === 'source' ? 'S' : 'D'}${count}`, type, uvMm }],
      }));
      set({ selectedOptodeId: optodeId, editorTool: 'select' });
    },
    moveOptode: (optodeId, uvMm) => mutateActiveLayout((layout) => ({
      ...layout,
      optodes: layout.optodes.map((optode) => optode.id === optodeId ? { ...optode, uvMm } : optode),
    })),
    deleteSelectedOptode: () => {
      const selected = get().selectedOptodeId;
      if (!selected) return;
      mutateActiveLayout((layout) => ({
        ...layout,
        optodes: layout.optodes.filter((optode) => optode.id !== selected),
        pairs: layout.pairs.filter((pair) => pair.sourceId !== selected && pair.detectorId !== selected),
      }));
      set({ selectedOptodeId: null });
    },
    generateGrid: (columns, rows, pitchMm) => {
      const safeColumns = Math.max(1, Math.min(12, Math.round(columns)));
      const safeRows = Math.max(1, Math.min(12, Math.round(rows)));
      if (safeColumns * safeRows > 100 || pitchMm < 1 || pitchMm > 100) {
        set({ toast: 'Grid must contain 100 optodes or fewer with a 1–100 mm pitch.' });
        return;
      }
      mutateActiveLayout((layout) => {
        let sourceCount = 0;
        let detectorCount = 0;
        const optodes: LayoutDefinition['optodes'] = [];
        for (let column = 0; column < safeColumns; column += 1) {
          for (let row = 0; row < safeRows; row += 1) {
            const type: OptodeType = (row + column) % 2 === 0 ? 'source' : 'detector';
            const count = type === 'source' ? ++sourceCount : ++detectorCount;
            optodes.push({
              id: id(),
              label: `${type === 'source' ? 'S' : 'D'}${count}`,
              type,
              uvMm: [
                (column - (safeColumns - 1) / 2) * pitchMm,
                ((safeRows - 1) / 2 - row) * pitchMm,
              ] as Vec2,
            });
          }
        }
        return { ...layout, gridSpacingMm: pitchMm, optodes, pairs: [] };
      });
      set({ selectedOptodeId: null, editorTool: 'select' });
    },
    reverseOptodeTypes: () => mutateActiveLayout((layout) => {
      let sourceCount = 0;
      let detectorCount = 0;
      const labels = new Map<string, string>();
      layout.optodes.slice().sort((a, b) => a.uvMm[0] - b.uvMm[0] || b.uvMm[1] - a.uvMm[1]).forEach((optode) => {
        const type: OptodeType = optode.type === 'source' ? 'detector' : 'source';
        const count = type === 'source' ? ++sourceCount : ++detectorCount;
        labels.set(optode.id, `${type === 'source' ? 'S' : 'D'}${count}`);
      });
      return {
        ...layout,
        optodes: layout.optodes.map((optode) => {
          const type: OptodeType = optode.type === 'source' ? 'detector' : 'source';
          return { ...optode, type, label: labels.get(optode.id)! };
        }),
        pairs: layout.pairs.map((pair) => ({
          ...pair,
          sourceId: pair.detectorId,
          detectorId: pair.sourceId,
        })),
      };
    }),
    generatePairs: (minMm, maxMm) => {
      const state = get();
      const layout = state.project.layouts.find((item) => item.id === state.activeLayoutId);
      if (!layout || minMm <= 0 || maxMm < minMm) return;
      mutateActiveLayout((value) => {
        const generated: LayoutDefinition['pairs'] = [];
        const sources = value.optodes.filter((optode) => optode.type === 'source');
        const detectors = value.optodes.filter((optode) => optode.type === 'detector');
        for (const source of sources) {
          for (const detector of detectors) {
            const valueMm = distance(source.uvMm, detector.uvMm);
            if (valueMm >= minMm && valueMm <= maxMm && generated.length < 256) {
              generated.push({
                id: id(), sourceId: source.id, detectorId: detector.id,
                channelNumber: 0,
                nominalDistanceMm: valueMm, shortChannel: valueMm <= 15,
              });
            }
          }
        }
        const byId = new Map(value.optodes.map((optode) => [optode.id, optode]));
        generated.sort((a, b) => {
          const aSource = byId.get(a.sourceId)!;
          const aDetector = byId.get(a.detectorId)!;
          const bSource = byId.get(b.sourceId)!;
          const bDetector = byId.get(b.detectorId)!;
          const aMid: Vec2 = [(aSource.uvMm[0] + aDetector.uvMm[0]) / 2, (aSource.uvMm[1] + aDetector.uvMm[1]) / 2];
          const bMid: Vec2 = [(bSource.uvMm[0] + bDetector.uvMm[0]) / 2, (bSource.uvMm[1] + bDetector.uvMm[1]) / 2];
          return bMid[1] - aMid[1] || aMid[0] - bMid[0];
        });
        return { ...value, pairs: generated.map((pair, index) => ({ ...pair, channelNumber: index + 1 })) };
      });
    },
    updatePairChannelNumber: (pairId, channelNumber) => mutateActiveLayout((layout) => ({
      ...layout,
      pairs: layout.pairs.map((pair) => pair.id === pairId
        ? { ...pair, channelNumber: Math.max(1, Math.round(channelNumber)) }
        : pair),
    })),
    undoLayout: () => set((state) => {
      const previous = state.pastLayouts.at(-1);
      const current = state.project.layouts.find((layout) => layout.id === state.activeLayoutId);
      if (!previous || !current) return state;
      return {
        project: {
          ...state.project,
          layouts: state.project.layouts.map((layout) => layout.id === current.id ? previous : layout),
          verifiedResults: [],
        },
        pastLayouts: state.pastLayouts.slice(0, -1),
        futureLayouts: [current, ...state.futureLayouts],
        projectRevision: state.projectRevision + 1,
      };
    }),
    redoLayout: () => set((state) => {
      const next = state.futureLayouts[0];
      const current = state.project.layouts.find((layout) => layout.id === state.activeLayoutId);
      if (!next || !current) return state;
      return {
        project: {
          ...state.project,
          layouts: state.project.layouts.map((layout) => layout.id === current.id ? next : layout),
          verifiedResults: [],
        },
        pastLayouts: [...state.pastLayouts, current],
        futureLayouts: state.futureLayouts.slice(1),
        projectRevision: state.projectRevision + 1,
      };
    }),
    saveLayoutToLibrary: () => {
      const state = get();
      const layout = state.project.layouts.find((item) => item.id === state.activeLayoutId);
      if (!layout) return;
      const snapshot = structuredClone({ ...layout, updatedAt: now() });
      set((value) => ({
        library: [...value.library.filter((item) => item.id !== snapshot.id), snapshot],
        toast: `Saved “${snapshot.name}” to the layout library.`,
      }));
    },
    placeLayout: (layoutId, anchorRasMm = [-55, -8, 70]) => {
      const state = get();
      const source = state.library.find((layout) => layout.id === layoutId)
        ?? state.project.layouts.find((layout) => layout.id === layoutId);
      if (!source) return null;
      const instanceId = id();
      const instanceLayout = structuredClone({
        ...source,
        id: id(),
        name: `${source.name} P${String(state.project.instances.length + 1).padStart(2, '0')}`,
        updatedAt: now(),
      });
      const instance: LayoutInstance = {
        id: instanceId,
        definitionId: instanceLayout.id,
        anchorRasMm,
        rotationRad: 0,
        mappingRotationRad: 0,
        visible: true,
        locked: true,
        overrides: [],
        digitizerPositions: [],
        derivedFromInstanceId: null,
        digitizerSessionId: null,
      };
      set((value) => ({
        project: {
          ...value.project,
          updatedAt: now(),
          layouts: [...value.project.layouts, instanceLayout],
          instances: [...value.project.instances, instance],
          verifiedResults: [],
        },
        selectedInstanceId: instanceId,
        selectedHeadOptodeId: null,
        selectedHeadPairId: null,
        instanceEditMode: 'group',
        projectRevision: value.projectRevision + 1,
      }));
      return instanceId;
    },
    selectInstance: (selectedInstanceId, selectedHeadOptodeId = null) => set({
      selectedInstanceId,
      selectedHeadOptodeId,
      selectedHeadPairId: null,
    }),
    selectChannel: (selectedInstanceId, selectedHeadPairId) => set((state) => ({
      selectedInstanceId,
      selectedHeadOptodeId: null,
      selectedHeadPairId,
      instanceEditMode: 'group',
      project: {
        ...state.project,
        instances: state.project.instances.map((instance) => instance.id === selectedInstanceId
          ? { ...instance, locked: true }
          : instance),
      },
    })),
    setInstanceEditMode: (instanceEditMode) => set((state) => ({
      instanceEditMode,
      project: {
        ...state.project,
        instances: state.project.instances.map((instance) => instance.id === state.selectedInstanceId
          ? { ...instance, locked: instanceEditMode === 'group' }
          : instance),
      },
    })),
    updateInstanceAnchor: (instanceId, anchorRasMm) => set((state) => ({
      project: {
        ...state.project,
        updatedAt: now(),
        instances: state.project.instances.map((instance) => instance.id === instanceId
          ? { ...instance, anchorRasMm, fitQc: undefined }
          : instance),
        verifiedResults: state.project.verifiedResults.filter((result) => result.instanceId !== instanceId),
      },
      projectRevision: state.projectRevision + 1,
    })),
    rotateInstance: (instanceId, deltaRad) => set((state) => ({
      project: {
        ...state.project,
        updatedAt: now(),
        instances: state.project.instances.map((instance) => instance.id === instanceId
          ? { ...instance, rotationRad: instance.rotationRad + deltaRad, fitQc: undefined }
          : instance),
        verifiedResults: state.project.verifiedResults.filter((result) => result.instanceId !== instanceId),
      },
      projectRevision: state.projectRevision + 1,
    })),
    rotateMapping: (instanceId, deltaRad) => set((state) => ({
      project: {
        ...state.project,
        updatedAt: now(),
        instances: state.project.instances.map((instance) => instance.id === instanceId
          ? { ...instance, mappingRotationRad: (instance.mappingRotationRad ?? 0) + deltaRad, fitQc: undefined }
          : instance),
        verifiedResults: state.project.verifiedResults.filter((result) => result.instanceId !== instanceId),
      },
      projectRevision: state.projectRevision + 1,
    })),
    toggleInstanceVisibility: (instanceId) => set((state) => ({
      project: {
        ...state.project,
        instances: state.project.instances.map((instance) => instance.id === instanceId
          ? { ...instance, visible: !(instance.visible ?? true) }
          : instance),
      },
      selectedHeadOptodeId: state.selectedInstanceId === instanceId ? null : state.selectedHeadOptodeId,
      selectedHeadPairId: state.selectedInstanceId === instanceId ? null : state.selectedHeadPairId,
    })),
    removeInstance: (instanceId) => set((state) => {
      const removed = state.project.instances.find((instance) => instance.id === instanceId);
      const instances = state.project.instances.filter((instance) => instance.id !== instanceId);
      const definitionStillUsed = removed && instances.some((instance) => instance.definitionId === removed.definitionId);
      return {
        project: {
          ...state.project,
          instances,
          layouts: removed && !definitionStillUsed
            ? state.project.layouts.filter((layout) => layout.id !== removed.definitionId)
            : state.project.layouts,
          verifiedResults: state.project.verifiedResults.filter((result) => result.instanceId !== instanceId),
        },
        selectedInstanceId: state.selectedInstanceId === instanceId ? instances[0]?.id ?? null : state.selectedInstanceId,
        selectedHeadOptodeId: null,
        selectedHeadPairId: null,
        projectRevision: state.projectRevision + 1,
      };
    }),
    updateInstanceOverride: (instanceId, optodeId, uvMm) => set((state) => ({
      project: {
        ...state.project,
        updatedAt: now(),
        instances: state.project.instances.map((instance) => instance.id === instanceId
          ? {
              ...instance,
              overrides: [
                ...instance.overrides.filter((override) => override.optodeId !== optodeId),
                { optodeId, uvMm },
              ],
              fitQc: undefined,
            }
          : instance),
        verifiedResults: state.project.verifiedResults.filter((result) => result.instanceId !== instanceId),
      },
      projectRevision: state.projectRevision + 1,
    })),
    resetInstanceOverride: (instanceId, optodeId) => set((state) => ({
      project: {
        ...state.project,
        instances: state.project.instances.map((instance) => instance.id === instanceId
          ? { ...instance, overrides: instance.overrides.filter((override) => override.optodeId !== optodeId) }
          : instance),
      },
      projectRevision: state.projectRevision + 1,
    })),
    commitPlacement: (committed, projections) => set((state) => ({
      project: {
        ...state.project,
        instances: state.project.instances.map((instance) => instance.id === committed.id ? committed : instance),
        verifiedResults: [
          ...state.project.verifiedResults.filter((result) => result.instanceId !== committed.id),
          ...projections,
        ],
      },
    })),
    setProjectionMode: (mode) => set((state) => ({
      project: {
        ...state.project,
        projectionSettings: { ...state.project.projectionSettings, mode },
        verifiedResults: [],
      },
      projectRevision: state.projectRevision + 1,
    })),
    setOptodeRadius: (radiusMm) => set((state) => ({
      project: {
        ...state.project,
        projectionSettings: {
          ...state.project.projectionSettings,
          optodeRadiusMm: Math.max(1, Math.min(15, radiusMm)),
        },
        verifiedResults: [],
      },
      projectRevision: state.projectRevision + 1,
    })),
    setDefaultDepth: (defaultDepthMm) => set((state) => ({
      project: {
        ...state.project,
        projectionSettings: { ...state.project.projectionSettings, defaultDepthMm },
        verifiedResults: [],
      },
      projectRevision: state.projectRevision + 1,
    })),
    setAnatomyLayer: (layer, visible) => set((state) => ({
      anatomyVisibility: { ...state.anatomyVisibility, [layer]: visible },
    })),
    setAnatomyAppearance: (layer, appearance) => set((state) => ({
      anatomyAppearance: {
        ...state.anatomyAppearance,
        [layer]: {
          ...state.anatomyAppearance[layer],
          ...appearance,
          opacity: appearance.opacity === undefined
            ? state.anatomyAppearance[layer].opacity
            : Math.max(0.05, Math.min(1, appearance.opacity)),
        },
      },
    })),
  };
});

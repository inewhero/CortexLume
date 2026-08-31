import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  channelSensitivityPath,
  distance3,
  fittedOptodePositions,
  formatRas,
  projectToCorticalContact,
  projectScalpSphereCenter,
  getSurfaceModelStatus,
  subscribeSurfaceModelStatus,
} from '../lib/geometry';
import { materializeProjectionSnapshot } from '../lib/projectionSnapshot';
import { confirmProjectTransition } from '../lib/unsavedChanges';
import { updateTransmissionDepth } from '../lib/transmissionDepth';
import { getMissingBidsFields } from '../lib/bidsValidation';
import { useProjectStore, type AnatomyAppearance, type AnatomyVisibility } from '../store/projectStore';
import type { DigitizerImport, ProjectOperationOptions, Vec3 } from '@cortexlume/contracts';
import { DigitizerDialog, type MappingScope } from './DigitizerDialog';
import { FIVE_POINT_LABELS, type FivePointLabel } from '../lib/digitizer';
import { TargetMapImportDialog } from './TargetMapImportDialog';
import { WorkflowExportActions } from './WorkflowExportActions';

const ANATOMY_LAYERS: Array<{ key: keyof AnatomyVisibility; label: string; code: string }> = [
  { key: 'scalp', label: 'Scalp envelope', code: 'SCLP' },
  { key: 'grayMatter', label: 'Gray matter', code: 'GM' },
  { key: 'whiteMatter', label: 'White matter', code: 'WM' },
  { key: 'fivePoint', label: 'Five-point reference', code: '5PT' },
  { key: 'tenTen', label: '10–10 positions', code: '10-10' },
  { key: 'pointLabels', label: 'Position labels', code: 'LBL' },
  { key: 'channelLabels', label: 'Channel numbers', code: 'CH' },
];

function ProbabilityList({ values }: { values: Array<{ label: string; probability: number }> }) {
  if (values.length === 0) return <div className="empty-probability">NO ATLAS LABEL AT THIS VOXEL</div>;
  return <div className="probability-list">{values.map((value) => (
    <div key={value.label}>
      <span>{value.label}</span><strong>{Math.round(value.probability * 100)}%</strong>
      <i><b style={{ width: `${Math.max(2, value.probability * 100)}%` }} /></i>
    </div>
  ))}</div>;
}

export function Inspector() {
  const [corticalRegions, setCorticalRegions] = useState<Array<{ label: string; probability: number }>>([]);
  const [materialPopup, setMaterialPopup] = useState<keyof AnatomyAppearance | null>(null);
  const materialPopupRef = useRef<HTMLDivElement>(null);
  const [digitizerDialog, setDigitizerDialog] = useState<{ kind: 'import'; data: DigitizerImport } | { kind: 'manual' } | null>(null);
  const [targetMapDialog, setTargetMapDialog] = useState(false);
  const [fivePointTargets, setFivePointTargets] = useState<Record<FivePointLabel, Vec3> | null>(null);
  const {
    project, projectPath, anatomyVisibility, anatomyAppearance,
    selectedInstanceId, selectedHeadOptodeId, selectedHeadPairId,
    newProject, loadProject, setProjectPath, setProjectName, setToast,
    projectOperation, setProjectOperation,
    setProjectionMode, resetInstanceOverride, setAnatomyLayer, setAnatomyAppearance,
    setBidsSettingsExpanded, setDefaultDepth, setPairDepthOverride,
    confirmDigitizerMapping, confirmFivePointCalibration, setDigitizerPreview,
    functionalTarget, setFunctionalTarget, setFunctionalTargetVisible,
    anatomicalCoverage, anatomicalCoverageEnabled, anatomicalCoverageMode,
    selectedCoverageRegionIndex, anatomicalCoverageError,
    setAnatomicalCoverageEnabled, setAnatomicalCoverageMode, setSelectedCoverageRegion,
  } = useProjectStore();
  const surfaceStatus = useSyncExternalStore(
    subscribeSurfaceModelStatus, getSurfaceModelStatus, getSurfaceModelStatus,
  );
  const surfaceVerified = surfaceStatus.state === 'verified';
  const instance = project.instances.find((item) => item.id === selectedInstanceId);
  const layout = project.layouts.find((item) => item.id === instance?.definitionId);
  const optode = layout?.optodes.find((item) => item.id === selectedHeadOptodeId);
  const pair = layout?.pairs.find((item) => item.id === selectedHeadPairId);
  const positions = useMemo(() => surfaceVerified && layout && instance
    ? fittedOptodePositions(layout, instance)
    : new Map(), [layout, instance, surfaceVerified]);
  const radiusMm = project.projectionSettings.optodeRadiusMm ?? 3.6;
  const transmissionDepthMm = pair
    ? instance?.pairDepthOverridesMm?.[pair.id]
      ?? project.projectionSettings.defaultDepthMm ?? 25
    : project.projectionSettings.defaultDepthMm ?? 25;
  const pairSource = pair ? positions.get(pair.sourceId) : undefined;
  const pairDetector = pair ? positions.get(pair.detectorId) : undefined;
  const scalp = selectedHeadOptodeId
    ? positions.get(selectedHeadOptodeId)
    : pairSource && pairDetector
      ? [
          (pairSource[0] + pairDetector[0]) / 2,
          (pairSource[1] + pairDetector[1]) / 2,
          (pairSource[2] + pairDetector[2]) / 2,
        ] as [number, number, number]
      : undefined;
  const channelPath = pairSource && pairDetector
    ? channelSensitivityPath(pairSource, pairDetector, radiusMm, transmissionDepthMm)
    : undefined;
  // Optodes retain a single-ray reference; channel labels summarize the sampled path.
  const cortical = channelPath?.corticalContact ?? (scalp ? projectToCorticalContact(scalp) : undefined);
  const depthTarget = channelPath?.target;
  const scalpMni = scalp ? projectScalpSphereCenter(scalp, radiusMm) : undefined;
  const override = instance?.overrides.find((item) => item.optodeId === selectedHeadOptodeId);
  const mappingScopes = useMemo<MappingScope[]>(() => {
    if (!surfaceVerified) return [];
    const visibleInstances = project.instances.filter((candidate) => candidate.visible !== false);
    const patches = visibleInstances.flatMap((candidate) => {
      const index = project.instances.findIndex((instance) => instance.id === candidate.id);
      const definition = project.layouts.find((item) => item.id === candidate.definitionId);
      if (!definition) return [];
      const fitted = fittedOptodePositions(definition, candidate);
      return [{
        id: candidate.id,
        label: `P${String(index + 1).padStart(2, '0')} · ${definition.name}`,
        targets: definition.optodes.map((item) => ({ instanceId: candidate.id, optodeId: item.id, label: `P${String(index + 1).padStart(2, '0')} · ${item.label}`, type: item.type, rasMm: fitted.get(item.id)! })),
      }];
    });
    return patches.length > 1 ? [...patches, { id: 'all', label: 'ALL LOADED PATCHES', targets: patches.flatMap((patch) => patch.targets) }] : patches;
  }, [project.instances, project.layouts, surfaceVerified]);
  const visibleChannelCount = useMemo(() => project.instances
    .filter((candidate) => candidate.visible !== false)
    .reduce((sum, candidate) => sum + (project.layouts.find((item) => item.id === candidate.definitionId)?.pairs.length ?? 0), 0),
  [project.instances, project.layouts]);

  useEffect(() => {
    if (visibleChannelCount === 0 && anatomicalCoverageEnabled) setAnatomicalCoverageEnabled(false);
  }, [anatomicalCoverageEnabled, setAnatomicalCoverageEnabled, visibleChannelCount]);

  useEffect(() => {
    if (!anatomicalCoverageEnabled
      || anatomicalCoverageMode !== 'region'
      || selectedCoverageRegionIndex != null) return;
    const firstRegion = anatomicalCoverage?.regions[0];
    if (firstRegion) setSelectedCoverageRegion(firstRegion.regionIndex);
  }, [
    anatomicalCoverage,
    anatomicalCoverageEnabled,
    anatomicalCoverageMode,
    selectedCoverageRegionIndex,
    setSelectedCoverageRegion,
  ]);

  useEffect(() => {
    void fetch(new URL('./anatomy/landmarks.json', window.location.href).href)
      .then((response) => response.json())
      .then((data: { points: Array<{ label: string; rasMm: Vec3; system: string }> }) => {
        const targets = Object.fromEntries(FIVE_POINT_LABELS.map((label) => [label, data.points.find((point) => point.system === 'five-point' && point.label === label)?.rasMm]));
        if (Object.values(targets).every(Boolean)) setFivePointTargets(targets as Record<FivePointLabel, Vec3>);
      });
  }, []);

  useEffect(() => {
    let current = true;
    setCorticalRegions([]);
    if (!cortical || !window.cortexlume) return () => { current = false; };
    const lookup = channelPath
      ? window.cortexlume.science.atlasLookupPath(
          channelPath.points,
          project.projectionSettings.atlasProbabilityThreshold,
        )
      : window.cortexlume.science.atlasLookup(
          cortical,
          project.projectionSettings.atlasProbabilityThreshold,
        );
    void lookup
      .then((values) => {
        if (current) setCorticalRegions(values.map((value) => ({ label: value.labelEn, probability: value.probability })));
      })
      .catch(() => {
        if (current) setCorticalRegions([]);
      });
    return () => { current = false; };
  }, [cortical?.[0], cortical?.[1], cortical?.[2], pair?.id, transmissionDepthMm, project.projectionSettings.atlasProbabilityThreshold]);

  useEffect(() => {
    const closeMaterialPopup = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('[data-material-trigger]') || materialPopupRef.current?.contains(target)) return;
      setMaterialPopup(null);
    };
    document.addEventListener('pointerdown', closeMaterialPopup);
    return () => document.removeEventListener('pointerdown', closeMaterialPopup);
  }, []);

  const openProject = async () => {
    try {
      if (!await confirmProjectTransition()) return;
      const opened = await window.cortexlume.project.open();
      if (opened) {
        loadProject(opened.project);
        setProjectPath(opened.path);
        setToast(`Loaded ${opened.project.name}.`);
      }
    } catch (error) {
      setToast(`Open error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const saveProject = async () => {
    try {
      const projectToSave = structuredClone(project);
      const result = await window.cortexlume.project.save(
        projectToSave,
        projectPath ?? undefined,
      );
      if (result) {
        useProjectStore.getState().markProjectSaved(projectToSave, result.path);
        setToast('Project archive saved.');
      }
    } catch (error) {
      setToast(`Save error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const exportCsv = async () => {
    const options: ProjectOperationOptions = { operationId: crypto.randomUUID() };
    setProjectOperation({ operationId: options.operationId!, operation: 'export', phase: 'starting', completed: 0, total: 1 });
    try {
      const snapshot = materializeProjectionSnapshot(project);
      const annotated = await window.cortexlume.science.annotateProject(snapshot, options);
      const result = await window.cortexlume.export.csv(annotated, options);
      if (result) {
        setToast(`Exported ${result.files.length} files to ${result.directory}${result.warnings.length ? ` · ${result.warnings.length} warning(s)` : ''}.`);
      }
    } catch (error) {
      setToast(`CSV export error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setProjectOperation((current) => current?.operationId === options.operationId ? null : current);
    }
  };

  const exportBrainNet = async () => {
    const options: ProjectOperationOptions = { operationId: crypto.randomUUID() };
    setProjectOperation({ operationId: options.operationId!, operation: 'export', phase: 'starting', completed: 0, total: 1 });
    try {
      const snapshot = materializeProjectionSnapshot(project);
      const annotated = await window.cortexlume.science.annotateProject(snapshot, options);
      const result = await window.cortexlume.export.brainNet(annotated, options);
      if (result) {
        setToast(result.brainNet.launched
          ? `Exported ${result.files.length} files and opened BrainNet Viewer.`
          : `BrainNet files exported, but automatic launch was unavailable: ${result.brainNet.detail}`);
      }
    } catch (error) {
      setToast(`BrainNet export error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setProjectOperation((current) => current?.operationId === options.operationId ? null : current);
    }
  };

  const exportBids = async () => {
    const missingFields = getMissingBidsFields(project);
    setBidsSettingsExpanded(true, missingFields.map((field) => field.key));
    if (missingFields.length > 0) {
      setToast(`Complete BIDS settings before export: ${missingFields.map((field) => field.label).join(', ')}.`);
      return;
    }
    const options: ProjectOperationOptions = { operationId: crypto.randomUUID() };
    setProjectOperation({ operationId: options.operationId!, operation: 'export', phase: 'starting', completed: 0, total: 1 });
    try {
      const snapshot = materializeProjectionSnapshot(project);
      const annotated = await window.cortexlume.science.annotateProject(snapshot, options);
      const result = await window.cortexlume.export.bidsGeometry(annotated, options);
      if (result) {
        setToast(`Exported ${result.files.length} BIDS geometry files to ${result.directory}${result.warnings.length ? ` · ${result.warnings.length} warning(s)` : ''}.`);
      }
    } catch (error) {
      setToast(`BIDS export error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setProjectOperation((current) => current?.operationId === options.operationId ? null : current);
    }
  };

  const exportAtlasViewer = async () => {
    const supersededInstanceIds = new Set(project.instances.flatMap((instance) =>
      instance.derivedFromInstanceId ? [instance.derivedFromInstanceId] : []));
    const hasExportableInstance = project.instances.some((instance) => !supersededInstanceIds.has(instance.id));
    if (!hasExportableInstance) {
      setToast('AtlasViewer export requires a patch in 3D Align. Load a patch to 3D before exporting.');
      return;
    }
    const options: ProjectOperationOptions = { operationId: crypto.randomUUID() };
    setProjectOperation({ operationId: options.operationId!, operation: 'export', phase: 'starting', completed: 0, total: 1 });
    try {
      const snapshot = materializeProjectionSnapshot(project);
      const result = await window.cortexlume.export.atlasViewer(snapshot, options);
      if (result) {
        setToast(result.atlasViewer.scriptOpened
          ? `Exported ${result.files.length} files and opened the AtlasViewer MATLAB bridge. Review and run it in MATLAB.`
          : `AtlasViewer files exported, but the MATLAB bridge could not be opened automatically: ${result.atlasViewer.detail}`);
      }
    } catch (error) {
      setToast(`AtlasViewer export error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setProjectOperation((current) => current?.operationId === options.operationId ? null : current);
    }
  };

  const importDigitizer = async () => {
    if (project.instances.length === 0) {
      setToast('Load at least one patch into 3D Align before importing digitizer optodes.');
      return;
    }
    try {
      const result = await window.cortexlume.input.digitizer();
      if (result) setDigitizerDialog({ kind: 'import', data: result });
    } catch (error) {
      setToast(`Digitizer import error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const openFivePointEntry = () => {
    if (project.instances.length === 0) {
      setToast('Load at least one patch into 3D Align before entering five-point calibration.');
      return;
    }
    if (!fivePointTargets) {
      setToast('Five-point template references are still loading.');
      return;
    }
    setDigitizerDialog({ kind: 'manual' });
  };

  return (
    <div className="inspector-content">
      <section className="control-block project-control">
        <div className="control-block-title"><span>WORKFLOW</span></div>
        <label className="project-name-field">
          <span>PROJECT NAME</span>
          <input
            value={project.name}
            maxLength={120}
            onChange={(event) => setProjectName(event.target.value)}
            onBlur={() => {
              if (!project.name.trim()) setProjectName('Untitled layout study');
            }}
          />
        </label>
        {projectPath ? (
          <button
            type="button"
            className="project-file-path is-clickable"
            title={`Show in File Explorer: ${projectPath}`}
            onClick={() => {
              void window.cortexlume.project.reveal(projectPath).catch((error) => {
                setToast(`Open project location error: ${error instanceof Error ? error.message : String(error)}`);
              });
            }}
          >
            {projectPath}
          </button>
        ) : (
          <code className="project-file-path" title="This project has not been saved yet.">
            UNSAVED PROJECT
          </code>
        )}
        <div className="workflow-row"><span>PROJECT</span><div className="project-actions">
          <button onClick={() => void confirmProjectTransition().then((confirmed) => {
            if (!confirmed) return;
            newProject(); setToast('New project created.');
          }).catch((error) => {
            setToast(`New project error: ${error instanceof Error ? error.message : String(error)}`);
          })}>NEW</button>
          <button onClick={openProject}>OPEN</button>
          <button className="primary" onClick={saveProject}>SAVE</button>
        </div></div>
        <div className="workflow-row"><span>IMPORT</span><div className="project-actions">
          <button onClick={importDigitizer}>DIGITIZER</button>
          <button onClick={openFivePointEntry}>5-POINT</button>
          <button onClick={() => setTargetMapDialog(true)}>NIFTI MAP</button>
        </div></div>
        <div className="workflow-row"><span>EXPORT</span><WorkflowExportActions
          disabled={!surfaceVerified || projectOperation != null}
          disabledReason={!surfaceVerified ? surfaceStatus.issue ?? 'Verified HeadModel surfaces are required' : null}
          onCsv={exportCsv}
          onBids={exportBids}
          onBrainNet={exportBrainNet}
          onAtlasViewer={exportAtlasViewer}
        /></div>
        {surfaceStatus.state !== 'verified' && (
          <div className={`surface-export-status is-${surfaceStatus.state}`} title={surfaceStatus.issue ?? undefined}>
            {surfaceStatus.state === 'loading'
              ? 'SCIENTIFIC EXPORTS DISABLED · HEAD MODEL LOADING'
              : `SCIENTIFIC EXPORTS DISABLED · ${surfaceStatus.issue ?? 'HEAD MODEL FAILED'}`}
          </div>
        )}
      </section>

      {digitizerDialog && fivePointTargets && <DigitizerDialog
        mode={digitizerDialog} targets={fivePointTargets} scopes={mappingScopes}
        onClose={() => { setDigitizerPreview(null); setDigitizerDialog(null); }}
        onPreview={(session, mappings) => setDigitizerPreview({ session, mappings })}
        onAccept={(session, mappings, targetInstanceIds) => {
          if (mappings.length > 0) confirmDigitizerMapping(session, mappings); else confirmFivePointCalibration(session, targetInstanceIds);
          setDigitizerDialog(null);
          setToast(mappings.length > 0 ? `Mapped ${mappings.length} digitized optodes · mean correspondence ${(mappings.reduce((sum, mapping) => sum + mapping.distanceMm, 0) / mappings.length).toFixed(1)} mm.` : `Loaded five-point calibration · RMS residual ${session.calibration.rmsResidualMm.toFixed(1)} mm.`);
        }}
      />}

      {targetMapDialog && <TargetMapImportDialog
        importMap={(declaredSpace) => window.cortexlume.input.targetNifti(declaredSpace)}
        onApply={(map) => {
          setFunctionalTarget(map);
          setToast(`Functional target ${map.target.label} is active in 3D Align.`);
        }}
        onClose={() => setTargetMapDialog(false)}
        onToast={setToast}
      />}

      <section className="control-block">
        <div className="control-block-title"><span>ANATOMY LAYERS</span></div>
        <div className="layer-list">
          {ANATOMY_LAYERS.map((layer) => {
            const materialLayer = layer.key === 'grayMatter' || layer.key === 'whiteMatter' ? layer.key : null;
            const material = materialLayer ? anatomyAppearance[materialLayer] : null;
            return <Fragment key={layer.key}>
              <div className="layer-row">
                <span><code>{layer.code}</code>{layer.label}</span>
                <div className="layer-row-actions">
                  {materialLayer && material && <button
                    type="button"
                    data-material-trigger
                    className="material-swatch"
                    style={{ backgroundColor: material.color }}
                    aria-label={`Edit ${layer.label} material`}
                    title="Color and opacity"
                    onClick={() => setMaterialPopup((current) => current === materialLayer ? null : materialLayer)}
                  />}
                  <input
                    aria-label={`${layer.code} ${layer.label}`}
                    type="checkbox"
                    checked={anatomyVisibility[layer.key]}
                    onChange={(event) => setAnatomyLayer(layer.key, event.target.checked)}
                  />
                </div>
                {materialLayer && material && materialPopup === materialLayer && (
                  <div className="layer-material-popover" ref={materialPopupRef}>
                    <div className="material-popover-title"><strong>{layer.label}</strong><code>{Math.round(material.opacity * 100)}%</code></div>
                    <label className="material-color-field">
                      <span>COLOR</span>
                      <input
                        type="color" value={material.color}
                        aria-label={`${layer.label} color`}
                        onChange={(event) => setAnatomyAppearance(materialLayer, { color: event.target.value })}
                      />
                      <code>{material.color.toUpperCase()}</code>
                    </label>
                    <label className="material-opacity-field">
                      <span>OPACITY</span>
                      <input
                        type="range" min={5} max={100} step={1}
                        value={Math.round(material.opacity * 100)}
                        aria-label={`${layer.label} opacity`}
                        onInput={(event) => setAnatomyAppearance(materialLayer, { opacity: Number(event.currentTarget.value) / 100 })}
                      />
                    </label>
                  </div>
                )}
              </div>
              {layer.key === 'whiteMatter' && functionalTarget && (
                <div className="layer-row functional-map-layer">
                  <span title={functionalTarget.target.label}><code>FMAP</code>Functional map</span>
                  <div className="layer-row-actions">
                    <input
                      aria-label="FMAP Functional map"
                      type="checkbox"
                      checked={project.surfaceOverlay === 'functional-target'}
                      onChange={(event) => setFunctionalTargetVisible(event.target.checked)}
                    />
                  </div>
                </div>
              )}
            </Fragment>;
          })}
        </div>
      </section>

      <section className="control-block">
        <div className="control-block-title"><span>PROJECTION</span></div>
        <div className="segmented full-width">
          <button className={project.projectionSettings.mode === 'scalp' ? 'active' : ''} onClick={() => setProjectionMode('scalp')}>SCALP</button>
          <button className={project.projectionSettings.mode === 'cortex' ? 'active' : ''} onClick={() => setProjectionMode('cortex')}>CORTEX</button>
        </div>
        <label className="parameter-field">
          <span>TRANSMISSION DEPTH FROM SCALP</span>
          <div>
            <input
              type="range"
              min="5"
              max="40"
              step="1"
              value={transmissionDepthMm}
              onInput={(event) => {
                const depthMm = Number(event.currentTarget.value);
                updateTransmissionDepth(instance?.id ?? null, pair?.id ?? null, depthMm, {
                  setDefaultDepth,
                  setPairDepthOverride,
                });
              }}
            />
            <code>{transmissionDepthMm} mm</code>
          </div>
        </label>
      </section>

      <section className={`control-block anatomical-coverage-control ${visibleChannelCount === 0 ? 'is-disabled' : ''}`}>
        <div className="control-block-title"><span>ANATOMICAL COVERAGE</span></div>
        <div className="segmented full-width coverage-mode">
          <button
            disabled={visibleChannelCount === 0}
            aria-pressed={anatomicalCoverageEnabled && anatomicalCoverageMode === 'mosaic'}
            className={anatomicalCoverageEnabled && anatomicalCoverageMode === 'mosaic' ? 'active' : ''}
            onClick={() => {
              if (anatomicalCoverageEnabled && anatomicalCoverageMode === 'mosaic') {
                setAnatomicalCoverageEnabled(false);
              } else {
                setSelectedCoverageRegion(null);
                if (!anatomicalCoverageEnabled) setAnatomicalCoverageEnabled(true);
              }
            }}
          >OVERALL MOSAIC</button>
          <button
            disabled={visibleChannelCount === 0}
            aria-pressed={anatomicalCoverageEnabled && anatomicalCoverageMode === 'region'}
            className={anatomicalCoverageEnabled && anatomicalCoverageMode === 'region' ? 'active' : ''}
            onClick={() => {
              if (anatomicalCoverageEnabled && anatomicalCoverageMode === 'region') {
                setAnatomicalCoverageEnabled(false);
              } else {
                if (!anatomicalCoverageEnabled) setAnatomicalCoverageEnabled(true);
                setAnatomicalCoverageMode('region');
                const firstRegionIndex = selectedCoverageRegionIndex
                  ?? anatomicalCoverage?.regions[0]?.regionIndex
                  ?? null;
                if (firstRegionIndex != null) setSelectedCoverageRegion(firstRegionIndex);
              }
            }}
          >SINGLE REGION</button>
        </div>
        {anatomicalCoverageEnabled && anatomicalCoverageMode === 'region' && (
          <select
            className="coverage-region-select"
            aria-label="Anatomical coverage region"
            value={selectedCoverageRegionIndex ?? ''}
            onChange={(event) => setSelectedCoverageRegion(Number(event.target.value))}
          >
            {anatomicalCoverage?.regions.map((region) => <option key={`${region.atlasId}:${region.labelEn}`} value={region.regionIndex}>
              {region.labelEn} · {Math.round(region.coveredAtlasMassFraction * 100)}%
            </option>)}
          </select>
        )}
        {anatomicalCoverageError && <p className="coverage-control-error">{anatomicalCoverageError}</p>}
      </section>

      <section className="control-block selection-block">
        <div className="control-block-title"><span>SELECTION</span></div>
        {!instance && <div className="empty-state">LOAD OR DRAG A PATCH INTO THE 3D PANEL</div>}
        {instance && !optode && !pair && (
          <dl>
            <dt>INSTANCE</dt><dd>{layout?.name ?? '—'}</dd>
            <dt>ANCHOR MNI</dt><dd>{formatRas(instance.anchorRasMm)}</dd>
            <dt>EDIT MODE</dt><dd>{instance.locked ? 'PATCH' : 'OPTODES'}</dd>
          </dl>
        )}
        {instance && optode && (
          <>
            <div className="selection-heading">
              <i className={optode.type === 'source' ? 'source-dot' : 'detector-dot'} />
              <div><strong>{optode.label}</strong><span>{optode.type.toUpperCase()}</span></div>
            </div>
            <dl>
              <dt>SCALP MNI</dt><dd>{formatRas(scalpMni)}</dd>
              <dt>CORTICAL CONTACT MNI</dt><dd>{formatRas(cortical)}</dd>
              <dt>REFERENCE REGION</dt><dd><ProbabilityList values={corticalRegions} /></dd>
            </dl>
            {override && <button className="wide" onClick={() => resetInstanceOverride(instance.id, optode.id)}>RESET LOCAL OFFSET</button>}
          </>
        )}
        {instance && pair && (
          <>
            <div className="selection-heading channel-selection-heading">
              <i>CH</i>
              <div><strong>CH{pair.channelNumber ?? '—'}</strong><span>CHANNEL · READ ONLY</span></div>
            </div>
            <dl>
              <dt>SCALP MNI</dt><dd>{formatRas(scalpMni)}</dd>
              <dt>CORTICAL CONTACT MNI</dt><dd>{formatRas(cortical)}</dd>
              <dt>DEPTH TARGET MNI</dt><dd>{formatRas(depthTarget)}</dd>
              <dt>PATH REGIONS</dt><dd><ProbabilityList values={corticalRegions} /></dd>
            </dl>
          </>
        )}
      </section>

      {layout && (
        <section className="control-block pair-list-panel">
          <div className="control-block-title"><span>CONNECTED CHANNELS</span><code>{layout.pairs.length}</code></div>
          <div className="pair-list">
            {layout.pairs
              .filter((item) => selectedHeadPairId
                ? item.id === selectedHeadPairId
                : !selectedHeadOptodeId || item.sourceId === selectedHeadOptodeId || item.detectorId === selectedHeadOptodeId)
              .map((pair) => {
                const byId = new Map(layout.optodes.map((item) => [item.id, item]));
                const source = positions.get(pair.sourceId);
                const detector = positions.get(pair.detectorId);
                const realizedDistance = source && detector ? distance3(source, detector) : pair.nominalDistanceMm;
                return <div key={pair.id}><code>CH{pair.channelNumber ?? '—'}</code><span>{byId.get(pair.sourceId)?.label}—{byId.get(pair.detectorId)?.label}</span><strong>{realizedDistance.toFixed(1)} mm</strong></div>;
              })}
          </div>
        </section>
      )}
    </div>
  );
}

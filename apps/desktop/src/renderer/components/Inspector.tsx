import { useEffect, useMemo, useRef, useState } from 'react';
import {
  channelSensitivityPath,
  distance3,
  fittedOptodePositions,
  formatRas,
  projectToCorticalContact,
  projectScalpSphereCenter,
} from '../lib/geometry';
import { materializeProjectionSnapshot } from '../lib/projectionSnapshot';
import { getMissingBidsFields } from '../lib/bidsValidation';
import { useProjectStore, type AnatomyAppearance, type AnatomyVisibility } from '../store/projectStore';

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
  const {
    project, projectPath, anatomyVisibility, anatomyAppearance,
    selectedInstanceId, selectedHeadOptodeId, selectedHeadPairId,
    newProject, loadProject, setProjectPath, setProjectName, setToast,
    setProjectionMode, resetInstanceOverride, setAnatomyLayer, setAnatomyAppearance,
    setBidsSettingsExpanded, setDefaultDepth,
  } = useProjectStore();
  const instance = project.instances.find((item) => item.id === selectedInstanceId);
  const layout = project.layouts.find((item) => item.id === instance?.definitionId);
  const optode = layout?.optodes.find((item) => item.id === selectedHeadOptodeId);
  const pair = layout?.pairs.find((item) => item.id === selectedHeadPairId);
  const positions = useMemo(() => layout && instance ? fittedOptodePositions(layout, instance) : new Map(), [layout, instance]);
  const radiusMm = project.projectionSettings.optodeRadiusMm ?? 3.6;
  const transmissionDepthMm = project.projectionSettings.defaultDepthMm ?? 25;
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
  const cortical = channelPath?.target ?? (scalp ? projectToCorticalContact(scalp) : undefined);
  const scalpMni = scalp ? projectScalpSphereCenter(scalp, radiusMm) : undefined;
  const override = instance?.overrides.find((item) => item.optodeId === selectedHeadOptodeId);

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

  const saveProject = async (saveAs = false) => {
    try {
      const result = await window.cortexlume.project.save(
        project,
        saveAs ? undefined : projectPath ?? undefined,
      );
      if (result) {
        setProjectPath(result.path);
        setToast(saveAs ? 'Project archive saved as a new file.' : 'Project archive saved.');
      }
    } catch (error) {
      setToast(`Save error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const exportCsv = async () => {
    try {
      const snapshot = materializeProjectionSnapshot(project);
      const result = await window.cortexlume.export.csv(await window.cortexlume.science.annotateProject(snapshot));
      if (result) {
        setToast(`Exported ${result.files.length} files to ${result.directory}${result.warnings.length ? ` · ${result.warnings.length} warning(s)` : ''}.`);
      }
    } catch (error) {
      setToast(`CSV export error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const exportBids = async () => {
    const missingFields = getMissingBidsFields(project);
    setBidsSettingsExpanded(true, missingFields.map((field) => field.key));
    if (missingFields.length > 0) {
      setToast(`Complete BIDS settings before export: ${missingFields.map((field) => field.label).join(', ')}.`);
      return;
    }
    try {
      const snapshot = materializeProjectionSnapshot(project);
      const result = await window.cortexlume.export.bidsGeometry(await window.cortexlume.science.annotateProject(snapshot));
      if (result) {
        setToast(`Exported ${result.files.length} BIDS geometry files to ${result.directory}${result.warnings.length ? ` · ${result.warnings.length} warning(s)` : ''}.`);
      }
    } catch (error) {
      setToast(`BIDS export error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <div className="inspector-content">
      <section className="control-block project-control">
        <div className="control-block-title"><span>PROJECT</span></div>
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
        <code className="project-file-path" title={projectPath ?? 'This project has not been saved yet.'}>
          {projectPath ?? 'UNSAVED PROJECT'}
        </code>
        <div className="project-actions">
          <button onClick={() => { newProject(); setToast('New project created.'); }}>NEW</button>
          <button onClick={openProject}>OPEN</button>
          <button className="primary" onClick={() => saveProject(false)}>SAVE</button>
        </div>
        <div className="project-actions">
          <button onClick={() => saveProject(true)}>SAVE AS</button>
          <button onClick={exportCsv}>EXPORT CSV</button>
          <button onClick={exportBids}>EXPORT BIDS</button>
        </div>
      </section>

      <section className="control-block">
        <div className="control-block-title"><span>ANATOMY LAYERS</span><code>VIEW</code></div>
        <div className="layer-list">
          {ANATOMY_LAYERS.map((layer) => {
            const materialLayer = layer.key === 'grayMatter' || layer.key === 'whiteMatter' ? layer.key : null;
            const material = materialLayer ? anatomyAppearance[materialLayer] : null;
            return (
            <div className="layer-row" key={layer.key}>
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
          );})}
        </div>
      </section>

      <section className="control-block">
        <div className="control-block-title"><span>PROJECTION</span><code>MNI</code></div>
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
              onInput={(event) => setDefaultDepth(Number(event.currentTarget.value))}
            />
            <code>{transmissionDepthMm} mm</code>
          </div>
        </label>
      </section>

      <section className="control-block selection-block">
        <div className="control-block-title"><span>SELECTION</span><code>{optode?.label ?? (pair ? `CH${pair.channelNumber ?? '—'}` : layout?.name) ?? 'NONE'}</code></div>
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
              <dt>CORTEX MNI</dt><dd>{formatRas(cortical)}</dd>
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
              <dt>CORTEX MNI</dt><dd>{formatRas(cortical)}</dd>
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

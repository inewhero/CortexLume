import { useEffect, useMemo, useRef, useState } from 'react';
import {
  corticalRegionProbabilities,
  distance3,
  fittedOptodePositions,
  formatRas,
  projectToCorticalSurface,
  projectScalpSphereCenter,
} from '../lib/geometry';
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
  return <div className="probability-list">{values.map((value) => (
    <div key={value.label}>
      <span>{value.label}</span><strong>{Math.round(value.probability * 100)}%</strong>
      <i><b style={{ width: `${Math.max(2, value.probability * 100)}%` }} /></i>
    </div>
  ))}</div>;
}

export function Inspector() {
  const [engineOnline, setEngineOnline] = useState(false);
  const [materialPopup, setMaterialPopup] = useState<keyof AnatomyAppearance | null>(null);
  const materialPopupRef = useRef<HTMLDivElement>(null);
  const {
    project, projectPath, anatomyVisibility, anatomyAppearance,
    selectedInstanceId, selectedHeadOptodeId, selectedHeadPairId,
    newProject, loadProject, setProjectPath, setProjectName, setToast,
    setProjectionMode, resetInstanceOverride, setAnatomyLayer, setAnatomyAppearance,
  } = useProjectStore();
  const instance = project.instances.find((item) => item.id === selectedInstanceId);
  const layout = project.layouts.find((item) => item.id === instance?.definitionId);
  const optode = layout?.optodes.find((item) => item.id === selectedHeadOptodeId);
  const pair = layout?.pairs.find((item) => item.id === selectedHeadPairId);
  const positions = useMemo(() => layout && instance ? fittedOptodePositions(layout, instance) : new Map(), [layout, instance]);
  const radiusMm = project.projectionSettings.optodeRadiusMm ?? 3.6;
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
  const cortical = scalp ? projectToCorticalSurface(scalp, radiusMm) : undefined;
  const scalpMni = scalp ? projectScalpSphereCenter(scalp, radiusMm) : undefined;
  const corticalRegions = cortical ? corticalRegionProbabilities(cortical) : [];
  const override = instance?.overrides.find((item) => item.optodeId === selectedHeadOptodeId);

  useEffect(() => {
    if (!window.cortexlume) return;
    void window.cortexlume.science.health().then((health) => setEngineOnline(health.ok));
  }, []);

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
        loadProject(opened);
        setProjectPath(null);
        setToast(`Loaded ${opened.name}.`);
      }
    } catch (error) {
      setToast(`Open error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const saveProject = async () => {
    try {
      const result = await window.cortexlume.project.save(project, projectPath ?? undefined);
      if (result) {
        setProjectPath(result.path);
        setToast('Project saved.');
      }
    } catch (error) {
      setToast(`Save error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const exportCsv = async () => {
    const result = await window.cortexlume.export.csv(project);
    if (result) setToast(`Coordinate tables exported to ${result.directory}`);
  };

  const exportBids = async () => {
    const result = await window.cortexlume.export.bidsGeometry(project);
    if (result) setToast(`BIDS geometry exported to ${result.directory}`);
  };

  return (
    <div className="inspector-content">
      <section className="control-block project-control">
        <div className="control-block-title"><span>PROJECT</span><code className={engineOnline ? 'online' : 'offline'}>{engineOnline ? 'ENGINE ONLINE' : 'ENGINE OFFLINE'}</code></div>
        <label className="project-name-field">
          <span>PROJECT NAME</span>
          <input value={project.name} onChange={(event) => setProjectName(event.target.value)} />
        </label>
        <div className="project-actions">
          <button onClick={() => { newProject(); setToast('New project created.'); }}>NEW</button>
          <button onClick={openProject}>OPEN</button>
          <button className="primary" onClick={saveProject}>SAVE</button>
        </div>
        <div className="project-actions two">
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
      </section>

      <section className="control-block selection-block">
        <div className="control-block-title"><span>SELECTION</span><code>{optode?.label ?? (pair ? `CH${pair.channelNumber ?? '—'}` : layout?.name) ?? 'NONE'}</code></div>
        {!instance && <div className="empty-state">LOAD OR DRAG A PATCH INTO THE 3D PANEL</div>}
        {instance && !optode && !pair && (
          <dl>
            <dt>INSTANCE</dt><dd>{layout?.name ?? '—'}</dd>
            <dt>ANCHOR MNI</dt><dd>{formatRas(instance.anchorRasMm)}</dd>
            <dt>ROTATION</dt><dd>{(instance.rotationRad * 180 / Math.PI).toFixed(1)}°</dd>
            <dt>MAPPING ROT.</dt><dd>{((instance.mappingRotationRad ?? 0) * 180 / Math.PI).toFixed(1)}°</dd>
            <dt>EDIT MODE</dt><dd>{instance.locked ? 'PATCH' : 'OPTODES'}</dd>
            <dt>LOCAL OFFSETS</dt><dd>{instance.overrides.length}</dd>
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
              <dt>CORTICAL REGION</dt><dd><ProbabilityList values={corticalRegions} /></dd>
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
              <dt>CORTICAL REGION</dt><dd><ProbabilityList values={corticalRegions} /></dd>
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

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { DigitizerImport, DigitizerOptodeMapping, DigitizerPoint, DigitizerSession, Vec3 } from '@cortexlume/contracts';
import { calibrateDigitizer, distanceBetween, FIVE_POINT_LABELS, landmarkAlias, nearestOptodeMappings, type FivePointLabel, type MappingTarget } from '../lib/digitizer';

type Mode = { kind: 'import'; data: DigitizerImport } | { kind: 'manual' };
export interface MappingScope { id: string; label: string; targets: MappingTarget[] }

function manualPoints(): DigitizerPoint[] {
  return FIVE_POINT_LABELS.map((label) => ({ id: crypto.randomUUID(), label, kind: 'landmark', rawPosition: [0, 0, 0] }));
}

export function DigitizerDialog({ mode, targets, scopes, onClose, onPreview, onAccept }: {
  mode: Mode;
  targets: Record<FivePointLabel, Vec3>;
  scopes: MappingScope[];
  onClose(): void;
  onPreview(session: DigitizerSession, mappings: DigitizerOptodeMapping[]): void;
  onAccept(session: DigitizerSession, mappings: DigitizerOptodeMapping[], targetInstanceIds: string[]): void;
}) {
  const [points, setPoints] = useState<DigitizerPoint[]>(() => mode.kind === 'import' ? mode.data.points : manualPoints());
  const [unit, setUnit] = useState<'mm' | 'cm' | 'm'>(() => mode.kind === 'import' ? mode.data.suggestedUnit : 'mm');
  const [scopeId, setScopeId] = useState(() => scopes.length === 1 ? scopes[0]!.id : '');
  const [error, setError] = useState<string | null>(null);
  const [calibrated, setCalibrated] = useState<DigitizerSession | null>(null);
  const [mappings, setMappings] = useState<DigitizerOptodeMapping[]>([]);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const dragOffset = useRef<{ x: number; y: number } | null>(null);
  const [assignments, setAssignments] = useState<Record<FivePointLabel, string>>(() => Object.fromEntries(FIVE_POINT_LABELS.map((label) => {
    const matched = points.find((point) => landmarkAlias(point.label) === label);
    return [label, matched?.id ?? ''];
  })) as Record<FivePointLabel, string>);

  const calibrationReady = useMemo(() => FIVE_POINT_LABELS.every((label) => assignments[label]), [assignments]);
  const scope = scopes.find((candidate) => candidate.id === scopeId);
  const source = mode.kind === 'import'
    ? { format: mode.data.format, fileName: mode.data.fileName, sha256: mode.data.sha256 }
    : { format: 'MANUAL', fileName: null, sha256: null };
  const positionById = useMemo(() => new Map(calibrated?.calibratedPoints.map((point) => [point.pointId, point.rasMm]) ?? []), [calibrated]);
  const availableOptodePoints = useMemo(() => {
    const fiducials = new Set(Object.values(assignments));
    return points.filter((point) => !fiducials.has(point.id) && point.kind !== 'landmark' && point.kind !== 'headshape');
  }, [assignments, points]);

  const updateManualCoordinate = (pointId: string, axis: number, value: string) => {
    setPoints((current) => current.map((point) => point.id === pointId
      ? { ...point, rawPosition: point.rawPosition.map((coordinate, index) => index === axis ? Number(value) : coordinate) as Vec3 }
      : point));
  };

  const calibrate = () => {
    try {
      setError(null);
      const session = calibrateDigitizer({
        name: mode.kind === 'import' ? mode.data.fileName.replace(/\.[^.]+$/, '') : 'Five-point calibration',
        source,
        points,
      }, assignments, targets, unit);
      if (!scope) throw new Error('Choose whether this digitizer acquisition belongs to one patch or the complete loaded array.');
      const targetInstanceIds = [...new Set(scope.targets.map((target) => target.instanceId))];
      if (mode.kind === 'manual') { onAccept(session, [], targetInstanceIds); return; }
      const optodePointIds = availableOptodePoints.map((point) => point.id);
      if (optodePointIds.length !== scope.targets.length) throw new Error(`Import rejected: ${optodePointIds.length} digitized optodes were found, while “${scope.label}” contains ${scope.targets.length}. Five-point landmarks and head-shape samples are excluded from this count.`);
      const nextMappings = nearestOptodeMappings(session, optodePointIds, scope.targets);
      setCalibrated(session);
      setMappings(nextMappings);
      onPreview(session, nextMappings);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const changeMapping = (target: MappingTarget, pointId: string) => {
    if (!calibrated) return;
    const pointRas = positionById.get(pointId);
    if (!pointRas) return;
    const next = mappings.map((mapping) => mapping.instanceId === target.instanceId && mapping.optodeId === target.optodeId
      ? { ...mapping, pointId, distanceMm: distanceBetween(target.rasMm, pointRas) }
      : mapping);
    setMappings(next);
    onPreview(calibrated, next);
  };

  const confirm = () => {
    if (!calibrated) return;
    if (new Set(mappings.map((mapping) => mapping.pointId)).size !== mappings.length) { setError('Each digitizer point must map to exactly one patch optode. Resolve duplicate assignments before confirmation.'); return; }
    onAccept(calibrated, mappings, [...new Set(mappings.map((mapping) => mapping.instanceId))]);
  };

  const refreshMappings = () => {
    if (!calibrated || !scope) return;
    try {
      setError(null);
      const next = nearestOptodeMappings(calibrated, availableOptodePoints.map((point) => point.id), scope.targets);
      setMappings(next);
      onPreview(calibrated, next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const clampPosition = (left: number, top: number) => {
    const rectangle = dialogRef.current?.getBoundingClientRect();
    const width = rectangle?.width ?? 0;
    const height = rectangle?.height ?? 0;
    const margin = 8;
    return {
      left: Math.min(Math.max(margin, left), Math.max(margin, window.innerWidth - width - margin)),
      top: Math.min(Math.max(margin, top), Math.max(margin, window.innerHeight - height - margin)),
    };
  };

  const startDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('button')) return;
    const rectangle = dialogRef.current?.getBoundingClientRect();
    if (!rectangle) return;
    dragOffset.current = { x: event.clientX - rectangle.left, y: event.clientY - rectangle.top };
    setPosition({ left: rectangle.left, top: rectangle.top });
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const drag = (event: ReactPointerEvent<HTMLElement>) => {
    if (!dragOffset.current) return;
    setPosition(clampPosition(event.clientX - dragOffset.current.x, event.clientY - dragOffset.current.y));
  };

  const stopDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (!dragOffset.current) return;
    dragOffset.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  useEffect(() => {
    if (!position) return undefined;
    const keepInsideViewport = () => setPosition((current) => current ? clampPosition(current.left, current.top) : null);
    window.addEventListener('resize', keepInsideViewport);
    return () => window.removeEventListener('resize', keepInsideViewport);
  }, [position !== null]);

  return createPortal((
    <div className={`dialog-backdrop ${mode.kind === 'manual' ? 'is-centered' : ''}`} role="presentation">
      <section
        ref={dialogRef}
        className={`digitizer-dialog ${mode.kind === 'manual' ? 'is-manual' : 'is-import'} ${calibrated ? 'is-correspondence' : ''}`}
        role="dialog"
        aria-label="Five-point digitizer calibration"
        style={position ? { position: 'fixed', left: position.left, top: position.top } : undefined}
      >
        <header onPointerDown={startDrag} onPointerMove={drag} onPointerUp={stopDrag} onPointerCancel={stopDrag}>
          <strong>{calibrated ? 'OPTODE CORRESPONDENCE' : 'FIVE-POINT CALIBRATION'}</strong>
          <div className="dialog-header-actions">{calibrated && <button className="mapping-refresh" title="Recalculate nearest one-to-one mapping" onClick={refreshMappings}>↻ REFRESH</button>}<button aria-label="Close" onClick={onClose}>×</button></div>
        </header>
        <div className="digitizer-dialog-body">
          {!calibrated && <>
            <div className={`digitizer-top-controls ${mode.kind === 'manual' ? 'manual' : ''}`}>
              <label className="digitizer-unit"><span>COORD. UNIT</span><select value={unit} onChange={(event) => setUnit(event.target.value as typeof unit)}><option value="mm">mm</option><option value="cm">cm</option><option value="m">m</option></select></label>
              {scopes.length > 0 && <label className="mapping-scope"><span>MAP TO</span><select value={scopeId} onChange={(event) => setScopeId(event.target.value)}><option value="">SELECT PATCH OR COMPLETE ARRAY</option>{scopes.map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.label} · {candidate.targets.length} OPTODE{candidate.targets.length === 1 ? '' : 'S'}</option>)}</select></label>}
            </div>
            {mode.kind === 'manual' ? (
              <div className="five-point-grid manual-grid">
                <div className="grid-head">LANDMARK</div><div className="grid-head">X</div><div className="grid-head">Y</div><div className="grid-head">Z</div>
                {FIVE_POINT_LABELS.map((label) => { const point = points.find((candidate) => candidate.label === label)!; return <div className="five-point-row" key={label}><strong>{label}</strong>{point.rawPosition.map((value, axis) => <input key={axis} type="number" step="0.1" value={value} onChange={(event) => updateManualCoordinate(point.id, axis, event.target.value)} />)}</div>; })}
              </div>
            ) : (
              <div className="five-point-assignments">
                <p>Match the five digitized fiducials to the locked template references. Recognized labels are assigned automatically.</p>
                {FIVE_POINT_LABELS.map((label) => <label key={label}><strong>{label}</strong><select value={assignments[label]} onChange={(event) => setAssignments((current) => ({ ...current, [label]: event.target.value }))}><option value="">SELECT POINT</option>{points.map((point) => <option value={point.id} key={point.id}>{point.label} · {point.rawPosition.map((value) => value.toFixed(2)).join(', ')}</option>)}</select></label>)}
              </div>
            )}
          </>}
          {calibrated && scope && <div className="mapping-confirm-list">
            <div className="mapping-qc"><strong>{scope.label}</strong><span>RMS 5PT {calibrated.calibration.rmsResidualMm.toFixed(2)} mm</span><span>MEAN MATCH {(mappings.reduce((sum, mapping) => sum + mapping.distanceMm, 0) / mappings.length).toFixed(1)} mm</span></div>
            <div className="mapping-list-head"><span>PATCH OPTODE</span><span>DIGITIZER POINT</span><span>DIST.</span></div>
            {scope.targets.map((target) => {
              const mapping = mappings.find((candidate) => candidate.instanceId === target.instanceId && candidate.optodeId === target.optodeId)!;
              return <div className="mapping-list-row" key={`${target.instanceId}:${target.optodeId}`}><strong className={target.type}>{target.label}</strong><select value={mapping.pointId} onChange={(event) => changeMapping(target, event.target.value)}>{availableOptodePoints.map((point) => <option value={point.id} key={point.id}>{point.label} · {point.kind.toUpperCase()}</option>)}</select><code>{mapping.distanceMm.toFixed(1)} mm</code></div>;
            })}
          </div>}
          {error && <div className="dialog-error">{error}</div>}
        </div>
        <footer><button onClick={onClose}>CANCEL</button>{calibrated ? <button className="primary" onClick={confirm}>CONFIRM</button> : <button className="primary" disabled={!calibrationReady || !scope} onClick={calibrate}>{mode.kind === 'manual' ? 'CALIBRATE' : 'PREVIEW'}</button>}</footer>
      </section>
    </div>
  ), document.body);
}

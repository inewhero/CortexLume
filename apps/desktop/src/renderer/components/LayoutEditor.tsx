import { useEffect, useMemo, useRef, useState } from 'react';
import { Circle, Group, Layer, Line, Rect, Stage, Text } from 'react-konva';
import type Konva from 'konva';
import type { Vec2 } from '@cortexlume/contracts';
import { useProjectStore } from '../store/projectStore';

function screenFromUv([u, v]: Vec2, width: number, height: number, scale: number): Vec2 {
  return [width / 2 + u * scale, height / 2 - v * scale];
}

function uvFromScreen([x, y]: Vec2, spacing: number, width: number, height: number, scale: number): Vec2 {
  const u = (x - width / 2) / scale;
  const v = (height / 2 - y) / scale;
  return [Math.round(u / spacing) * spacing, Math.round(v / spacing) * spacing];
}

export function LayoutEditor() {
  const shellRef = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState({ width: 396, height: 370 });
  const [minDistance, setMinDistance] = useState(25);
  const [maxDistance, setMaxDistance] = useState(40);
  const [gridColumns, setGridColumns] = useState(5);
  const [gridRows, setGridRows] = useState(3);
  const [gridPitch, setGridPitch] = useState(30);
  const [zoom, setZoom] = useState(1);
  const [editingPairId, setEditingPairId] = useState<string | null>(null);
  const [editingChannel, setEditingChannel] = useState('');
  const {
    project, activeLayoutId, editorTool, selectedOptodeId, pastLayouts, futureLayouts,
    setEditorTool, selectOptode, addOptode, moveOptode, deleteSelectedOptode,
    generateGrid, reverseOptodeTypes, generatePairs, updatePairChannelNumber,
    undoLayout, redoLayout, setOptodeRadius,
  } = useProjectStore();
  const layout = project.layouts.find((item) => item.id === activeLayoutId);
  const optodeRadiusMm = project.projectionSettings.optodeRadiusMm ?? 3.6;
  const byId = useMemo(() => new Map(layout?.optodes.map((optode) => [optode.id, optode]) ?? []), [layout]);

  useEffect(() => {
    const element = shellRef.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const width = Math.max(300, Math.floor(entry.contentRect.width));
      setStageSize({ width, height: Math.max(330, Math.min(560, Math.round(width * 0.83))) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setZoom(1);
  }, [layout?.id, layout?.optodes.length, layout?.pairs.length]);

  if (!layout) return <div className="empty-state">No layout is open.</div>;

  const { width, height } = stageSize;
  const maxU = Math.max(45, ...layout.optodes.map((optode) => Math.abs(optode.uvMm[0]) + layout.gridSpacingMm));
  const maxV = Math.max(45, ...layout.optodes.map((optode) => Math.abs(optode.uvMm[1]) + layout.gridSpacingMm));
  const fitScale = Math.max(1.2, Math.min(4, (width / 2 - 24) / maxU, (height / 2 - 24) / maxV));
  const scale = fitScale * zoom;
  const gridPx = layout.gridSpacingMm * scale;
  const gridLines = [];
  for (let x = (width / 2) % gridPx; x <= width; x += gridPx) {
    gridLines.push(<Line key={`x-${x}`} points={[x, 0, x, height]} stroke="#d5d9de" strokeWidth={0.55} />);
  }
  for (let y = (height / 2) % gridPx; y <= height; y += gridPx) {
    gridLines.push(<Line key={`y-${y}`} points={[0, y, width, y]} stroke="#d5d9de" strokeWidth={0.55} />);
  }

  const addAtPointer = (stage: Konva.Stage) => {
    if (editorTool === 'select') {
      selectOptode(null);
      return;
    }
    const point = stage.getPointerPosition();
    if (!point) return;
    addOptode(
      editorTool === 'add-source' ? 'source' : 'detector',
      uvFromScreen([point.x, point.y], layout.gridSpacingMm, width, height, scale),
    );
  };

  return (
    <div className="layout-editor-content">
      <div className="module-summary">
        <div><strong>{layout.name}</strong><span>{layout.optodes.length} OPTODES / {layout.pairs.length} CHANNELS</span></div>
        <div className="history-controls">
          <div className="zoom-controls">
            <button onClick={() => setZoom((value) => Math.max(0.6, value / 1.16))} title="Zoom out">−</button>
            <button className="zoom-value" onClick={() => setZoom(1)} title="Fit view">{Math.round(zoom * 100)}%</button>
            <button onClick={() => setZoom((value) => Math.min(2, value * 1.16))} title="Zoom in">+</button>
          </div>
          <button disabled={pastLayouts.length === 0} onClick={undoLayout} title="Undo">↶</button>
          <button disabled={futureLayouts.length === 0} onClick={redoLayout} title="Redo">↷</button>
        </div>
      </div>

      <div className="tool-grid">
        <button className={editorTool === 'select' ? 'active' : ''} onClick={() => setEditorTool('select')}>SELECT</button>
        <button className={editorTool === 'add-source' ? 'active source-tool' : ''} onClick={() => setEditorTool('add-source')}>+ SOURCE</button>
        <button className={editorTool === 'add-detector' ? 'active detector-tool' : ''} onClick={() => setEditorTool('add-detector')}>+ DETECTOR</button>
        <button disabled={!selectedOptodeId} onClick={deleteSelectedOptode}>DELETE</button>
      </div>

      <section className="control-block optode-size-control">
        <div className="control-block-title"><span>OPTODE SPHERE</span><code>Ø {(optodeRadiusMm * 2).toFixed(1)} MM</code></div>
        <div className="sphere-size-row">
          <input
            aria-label="Optode sphere diameter in millimetres"
            type="range" min={2} max={30} step={0.5}
            value={optodeRadiusMm * 2}
            onChange={(event) => setOptodeRadius(Number(event.target.value) / 2)}
          />
          <label><span>DIAMETER MM</span><input
            type="number" min={2} max={30} step={0.5}
            value={Number((optodeRadiusMm * 2).toFixed(1))}
            onChange={(event) => setOptodeRadius(Number(event.target.value) / 2)}
          /></label>
        </div>
      </section>

      <div className="konva-shell" ref={shellRef}>
        <Stage width={width} height={height} onWheel={(event) => {
          event.evt.preventDefault();
          setZoom((value) => Math.max(0.6, Math.min(2, value * (event.evt.deltaY > 0 ? 0.9 : 1.1))));
        }} onMouseDown={(event) => {
          if (event.target === event.target.getStage()) addAtPointer(event.target.getStage()!);
        }}>
          <Layer listening={false}>
            <Rect width={width} height={height} fill="#f4f5f3" />
            {gridLines}
            <Line points={[width / 2, 0, width / 2, height]} stroke="#7e878e" strokeWidth={1} />
            <Line points={[0, height / 2, width, height / 2]} stroke="#7e878e" strokeWidth={1} />
          </Layer>
          <Layer>
            {layout.pairs.map((pair) => {
              const source = byId.get(pair.sourceId);
              const detector = byId.get(pair.detectorId);
              if (!source || !detector) return null;
              const a = screenFromUv(source.uvMm, width, height, scale);
              const b = screenFromUv(detector.uvMm, width, height, scale);
              return (
                <Group key={pair.id}>
                  <Line listening={false} points={[...a, ...b]} stroke={pair.shortChannel ? '#c85c33' : '#78828a'} strokeWidth={1.4} opacity={0.92} />
                  <Rect
                    x={(a[0] + b[0]) / 2 - 10} y={(a[1] + b[1]) / 2 - 7}
                    width={20} height={14} fill="#eef0ed" stroke="#7c858a" strokeWidth={0.7}
                    onMouseDown={(event) => {
                      event.cancelBubble = true;
                      setEditingPairId(pair.id);
                      setEditingChannel(String(pair.channelNumber ?? ''));
                    }}
                  />
                  <Text
                    x={(a[0] + b[0]) / 2 - 10}
                    y={(a[1] + b[1]) / 2 - 7}
                    width={20} height={14} align="center" verticalAlign="middle"
                    text={`${pair.channelNumber ?? '—'}`}
                    fill="#3f484e"
                    fontStyle="bold"
                    fontSize={9}
                    onMouseDown={(event) => {
                      event.cancelBubble = true;
                      setEditingPairId(pair.id);
                      setEditingChannel(String(pair.channelNumber ?? ''));
                    }}
                  />
                </Group>
              );
            })}
            {layout.optodes.map((optode) => {
              const [x, y] = screenFromUv(optode.uvMm, width, height, scale);
              const selected = optode.id === selectedOptodeId;
              return (
                <Group
                  key={optode.id}
                  x={x}
                  y={y}
                  draggable={editorTool === 'select'}
                  onMouseDown={(event) => { event.cancelBubble = true; selectOptode(optode.id); }}
                  onDragEnd={(event) => moveOptode(
                    optode.id,
                    uvFromScreen([event.target.x(), event.target.y()], layout.gridSpacingMm, width, height, scale),
                  )}
                >
                  {selected && <Circle radius={16} stroke="#111718" strokeWidth={1.5} />}
                  <Circle radius={12.5} fill={optode.type === 'source' ? '#df4b3f' : '#1879a8'} stroke="#ffffff" strokeWidth={1.5} />
                  <Text
                    listening={false} text={optode.label}
                    x={-12.5} y={-7} width={25} height={14}
                    align="center" verticalAlign="middle"
                    fill="#ffffff" fontStyle="bold" fontSize={9.5}
                  />
                </Group>
              );
            })}
          </Layer>
        </Stage>
        {editingPairId && (() => {
          const pair = layout.pairs.find((item) => item.id === editingPairId);
          const source = pair ? byId.get(pair.sourceId) : undefined;
          const detector = pair ? byId.get(pair.detectorId) : undefined;
          if (!pair || !source || !detector) return null;
          const a = screenFromUv(source.uvMm, width, height, scale);
          const b = screenFromUv(detector.uvMm, width, height, scale);
          const commit = () => {
            updatePairChannelNumber(pair.id, Number(editingChannel) || 1);
            setEditingPairId(null);
          };
          return <input
            className="canvas-channel-input" autoFocus type="number" min={1}
            style={{ left: (a[0] + b[0]) / 2 - 20, top: (a[1] + b[1]) / 2 - 11 }}
            value={editingChannel} onChange={(event) => setEditingChannel(event.target.value)}
            onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') commit(); if (event.key === 'Escape') setEditingPairId(null); }}
          />;
        })()}
      </div>

      <section className="control-block">
        <div className="control-block-title"><span>QUICK MATRIX</span><code>X × Y</code></div>
        <div className="parameter-grid three">
          <label><span>X COLS</span><input type="number" min={1} max={12} value={gridColumns} onChange={(event) => setGridColumns(Number(event.target.value))} /></label>
          <label><span>Y ROWS</span><input type="number" min={1} max={12} value={gridRows} onChange={(event) => setGridRows(Number(event.target.value))} /></label>
          <label><span>PITCH MM</span><input type="number" min={1} max={100} value={gridPitch} onChange={(event) => setGridPitch(Number(event.target.value))} /></label>
        </div>
        <div className="button-row">
          <button className="primary" onClick={() => generateGrid(gridColumns, gridRows, gridPitch)}>BUILD {gridColumns}×{gridRows}</button>
          <button onClick={reverseOptodeTypes}>REVERSE S / D</button>
        </div>
      </section>

      <section className="control-block">
        <div className="control-block-title"><span>CHANNEL SOLVER</span><code>MM</code></div>
        <div className="parameter-grid two">
          <label><span>MIN</span><input type="number" min={1} max={100} value={minDistance} onChange={(event) => setMinDistance(Number(event.target.value))} /></label>
          <label><span>MAX</span><input type="number" min={1} max={100} value={maxDistance} onChange={(event) => setMaxDistance(Number(event.target.value))} /></label>
        </div>
        <div className="button-row">
          <button onClick={() => { setMinDistance(25); setMaxDistance(40); }}>25–40</button>
          <button onClick={() => { setMinDistance(5); setMaxDistance(15); }}>05–15</button>
          <button className="primary" onClick={() => generatePairs(minDistance, maxDistance)}>GENERATE CH</button>
        </div>
      </section>

      <section className="control-block channel-table-block">
        <div className="control-block-title"><span>CHANNEL INDEX</span><code>{layout.pairs.length}</code></div>
        <div className="channel-table">
          {layout.pairs
            .slice()
            .sort((a, b) => (a.channelNumber ?? 999) - (b.channelNumber ?? 999))
            .map((pair) => (
              <div className="channel-row" key={pair.id}>
                <label>CH<input type="number" min={1} value={pair.channelNumber ?? ''} onChange={(event) => updatePairChannelNumber(pair.id, Number(event.target.value) || 1)} /></label>
                <strong>{byId.get(pair.sourceId)?.label}—{byId.get(pair.detectorId)?.label}</strong>
                <span>{pair.nominalDistanceMm.toFixed(1)} mm</span>
              </div>
            ))}
        </div>
      </section>

    </div>
  );
}

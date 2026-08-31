import { getBuiltinPatchPreset } from '@cortexlume/core';
import { patchLibraryEntryKey, useProjectStore } from '../store/projectStore';

export function LayoutLibrary() {
  const { library, saveLayoutToLibrary, removeLibraryEntry, copyLayoutToEditor, placeLayout } = useProjectStore();
  const renderEntry = (entry: (typeof library)[number]) => {
    const layout = entry.layout;
    const entryKey = patchLibraryEntryKey(entry);
    const preset = entry.source === 'builtin-rule' ? getBuiltinPatchPreset(entry.presetId) : null;
    const builtIn = entry.source === 'builtin-rule';
    return (
      <div
        className="library-card"
        draggable
        key={entryKey}
        onDragStart={(event) => {
          event.dataTransfer.setData('application/x-cortexlume-layout', entryKey);
          event.dataTransfer.effectAllowed = 'copy';
        }}
      >
        <div className="library-card-info">
          <div className="library-card-heading">
            <strong>{layout.name}</strong>
            <span className={`library-kind ${builtIn ? 'built-in' : ''}`}>
              {builtIn ? 'BUILT-IN' : 'PROJECT'}
            </span>
          </div>
          <span>
            {preset?.rows != null && preset.columns != null
              ? `${preset.rows} rows × ${preset.columns} columns · `
              : ''}
            {layout.optodes.length} optodes · {layout.pairs.length} pairs
          </span>
          {preset && <span>{preset.pitchMm} mm nominal</span>}
        </div>
        <div className="library-card-actions">
          <button onClick={() => copyLayoutToEditor(entryKey)}>EDIT</button>
          <button onClick={() => placeLayout(entryKey)}>LOAD TO 3D</button>
          <button
            className="library-remove-button"
            aria-label={`Remove ${layout.name} from library`}
            title="Remove from library"
            onClick={() => removeLibraryEntry(entryKey)}
          >×</button>
        </div>
      </div>
    );
  };
  return (
    <section className="control-block library-panel">
      <div className="control-block-title">
        <span>PATCH LIBRARY</span>
        <button onClick={saveLayoutToLibrary}>STORE CURRENT</button>
      </div>
      <p className="library-note">
        Built-in templates use nominal 30 mm spacing. Edit creates a project copy.
      </p>
      <div className="library-list">
        {library.map(renderEntry)}
      </div>
    </section>
  );
}

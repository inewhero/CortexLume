import { useProjectStore } from '../store/projectStore';

export function LayoutLibrary() {
  const { library, saveLayoutToLibrary, placeLayout } = useProjectStore();
  return (
    <section className="control-block library-panel">
      <div className="control-block-title">
        <span>PATCH LIBRARY</span>
        <button onClick={saveLayoutToLibrary}>STORE CURRENT</button>
      </div>
      <div className="library-list">
        {library.map((layout) => (
          <div
            className="library-card"
            draggable
            key={layout.id}
            onDragStart={(event) => {
              event.dataTransfer.setData('application/x-cortexlume-layout', layout.id);
              event.dataTransfer.effectAllowed = 'copy';
            }}
          >
            <div>
              <strong>{layout.name}</strong>
              <span>{layout.optodes.length} optodes · {layout.pairs.length} pairs</span>
            </div>
            <button onClick={() => placeLayout(layout.id)}>LOAD TO 3D</button>
          </div>
        ))}
      </div>
    </section>
  );
}

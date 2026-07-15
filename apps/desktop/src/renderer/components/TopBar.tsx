import { useState } from 'react';

export function TopBar() {
  const [maximized, setMaximized] = useState(false);
  return (
    <header className="window-chrome">
      <div className="window-drag-region"><strong>CortexLume</strong></div>
      <div className="window-controls">
        <button aria-label="Minimize" title="Minimize" onClick={() => void window.cortexlume.window.minimize()}>—</button>
        <button
          aria-label={maximized ? 'Restore' : 'Maximize'}
          title={maximized ? 'Restore' : 'Maximize'}
          onClick={() => void window.cortexlume.window.toggleMaximize().then(setMaximized)}
        >{maximized ? '❐' : '□'}</button>
        <button className="window-close" aria-label="Close" title="Close" onClick={() => void window.cortexlume.window.close()}>×</button>
      </div>
    </header>
  );
}

import { useState } from 'react';

export function TopBar() {
  const [maximized, setMaximized] = useState(false);
  return (
    <header className="window-chrome">
      <div className="window-drag-region"><strong>CortexLume</strong></div>
      <div className="window-controls">
        <button aria-label="Minimize" title="Minimize" onClick={() => void window.cortexlume.window.minimize()}><span aria-hidden="true">&#xE921;</span></button>
        <button
          aria-label={maximized ? 'Restore' : 'Maximize'}
          title={maximized ? 'Restore' : 'Maximize'}
          onClick={() => void window.cortexlume.window.toggleMaximize().then(setMaximized)}
        ><span aria-hidden="true">{maximized ? '\uE923' : '\uE922'}</span></button>
        <button className="window-close" aria-label="Close" title="Close" onClick={() => void window.cortexlume.window.close()}><span aria-hidden="true">&#xE8BB;</span></button>
      </div>
    </header>
  );
}

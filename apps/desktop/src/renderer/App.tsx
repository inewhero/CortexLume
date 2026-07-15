import { useMemo, useState, type ReactNode } from 'react';
import { HeadViewport } from './components/HeadViewport';
import { Inspector } from './components/Inspector';
import { LayoutEditor } from './components/LayoutEditor';
import { LayoutLibrary } from './components/LayoutLibrary';
import { TopBar } from './components/TopBar';
import { useProjectStore } from './store/projectStore';

function PanelFrame({ title, side, collapsed = false, children }: {
  title: string;
  side?: 'left' | 'right';
  collapsed?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className={`workspace-panel panel-${side ?? 'center'} ${collapsed ? 'is-collapsed' : 'is-open'}`}
      aria-hidden={collapsed || undefined}
    >
      <header className="panel-chrome">
        <strong className="panel-title">{title}</strong>
      </header>
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function App() {
  const [leftVisible, setLeftVisible] = useState(true);
  const [rightVisible, setRightVisible] = useState(true);
  const { toast, setToast } = useProjectStore();
  const columns = useMemo(() => [
    leftVisible ? 'clamp(360px, 28vw, 440px)' : '0px',
    'minmax(460px, 1fr)',
    rightVisible ? 'clamp(300px, 22vw, 350px)' : '0px',
  ].join(' '), [leftVisible, rightVisible]);

  return (
    <div className="app-shell">
      <TopBar />
      <main className="workspace" style={{ gridTemplateColumns: columns }}>
        <PanelFrame title="Optode Design" side="left" collapsed={!leftVisible}>
          <div className="scroll-panel"><LayoutEditor /><LayoutLibrary /></div>
        </PanelFrame>
        <PanelFrame title="3D Align">
          <HeadViewport />
          <button className="boundary-toggle boundary-left" onClick={() => setLeftVisible((value) => !value)} title={leftVisible ? 'Collapse Optode Design' : 'Open Optode Design'}>{leftVisible ? '‹' : '›'}</button>
          <button className="boundary-toggle boundary-right" onClick={() => setRightVisible((value) => !value)} title={rightVisible ? 'Collapse Info Panel' : 'Open Info Panel'}>{rightVisible ? '›' : '‹'}</button>
        </PanelFrame>
        <PanelFrame title="Info Panel" side="right" collapsed={!rightVisible}>
          <div className="scroll-panel"><Inspector /></div>
        </PanelFrame>
      </main>
      {toast && <button className="toast" onClick={() => setToast(null)}>{toast}<span>×</span></button>}
    </div>
  );
}

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { HeadViewport } from './components/HeadViewport';
import { BidsSettings } from './components/BidsSettings';
import { Inspector } from './components/Inspector';
import { LayoutEditor } from './components/LayoutEditor';
import { LayoutLibrary } from './components/LayoutLibrary';
import { QuickTargetController } from './components/QuickTarget';
import { TopBar } from './components/TopBar';
import type { UpdateCheckResult } from '../shared/startup';
import { useProjectStore } from './store/projectStore';
import { confirmProjectTransition } from './lib/unsavedChanges';

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
  const loadProject = useProjectStore((state) => state.loadProject);
  const setProjectPath = useProjectStore((state) => state.setProjectPath);
  const setToast = useProjectStore((state) => state.setToast);
  const [leftVisible, setLeftVisible] = useState(true);
  const [rightVisible, setRightVisible] = useState(true);
  const [availableUpdate, setAvailableUpdate] = useState<UpdateCheckResult | null>(null);
  const columns = useMemo(() => [
    leftVisible ? 'clamp(360px, 28vw, 440px)' : '0px',
    'minmax(460px, 1fr)',
    rightVisible ? 'clamp(300px, 22vw, 350px)' : '0px',
  ].join(' '), [leftVisible, rightVisible]);

  useEffect(() => {
    let active = true;
    void window.cortexlume?.project.startup().then((opened) => {
      if (!active || !opened) return;
      loadProject(opened.project);
      setProjectPath(opened.path);
      setToast(`Loaded ${opened.project.name}.`);
    }).catch((error) => {
      if (active) setToast(`Open error: ${error instanceof Error ? error.message : String(error)}`);
    });
    return () => { active = false; };
  }, [loadProject, setProjectPath, setToast]);

  useEffect(() => {
    let active = true;
    let checking = false;
    const check = () => {
      const startup = window.cortexlume?.startup;
      if (!startup || !navigator.onLine || checking) return;
      checking = true;
      void startup.checkUpdate()
        .then((update) => {
          if (active) setAvailableUpdate(update.status === 'available' ? update : null);
        })
        .catch(() => {
          // Offline and unavailable update sources remain completely silent.
        })
        .finally(() => { checking = false; });
    };
    check();
    window.addEventListener('online', check);
    return () => {
      active = false;
      window.removeEventListener('online', check);
    };
  }, []);

  useEffect(() => window.cortexlume.window.onCloseRequested(() => {
    void confirmProjectTransition()
      .then((allow) => window.cortexlume.window.finishClose(allow))
      .catch((error) => {
        setToast(`Close error: ${error instanceof Error ? error.message : String(error)}`);
        return window.cortexlume.window.finishClose(false);
      });
  }), [setToast]);

  return (
    <div className="app-shell">
      <TopBar
        update={availableUpdate}
        onOpenUpdate={() => void confirmProjectTransition().then((confirmed) => {
          if (confirmed) return window.cortexlume?.startup.openRelease();
          return undefined;
        }).catch((error) => {
          setToast(`Update error: ${error instanceof Error ? error.message : String(error)}`);
        })}
      />
      <main className="workspace" style={{ gridTemplateColumns: columns }}>
        <PanelFrame title="Optode Design" side="left" collapsed={!leftVisible}>
          <div className="scroll-panel"><QuickTargetController /><LayoutEditor /><BidsSettings /><LayoutLibrary /></div>
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
    </div>
  );
}

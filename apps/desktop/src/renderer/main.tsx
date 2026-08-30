import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// React StrictMode deliberately mounts, disposes, and remounts the tree in
// development. Disposing the react-three-fiber Canvas explicitly loses its
// WebGL context; on affected ANGLE drivers that also tears down the freshly
// remounted context and leaves the live viewport blank. The desktop renderer
// already exercises effect cleanup in focused tests, so keep the long-lived
// scientific WebGL scene outside that development-only remount cycle.
createRoot(document.getElementById('root')!).render(<App />);

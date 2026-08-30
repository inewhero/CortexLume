import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('Info Panel project path interaction', () => {
  it('renders saved paths as a neutral project reveal button', () => {
    const inspector = readFileSync(fileURLToPath(new URL('./Inspector.tsx', import.meta.url)), 'utf8');
    const styles = readFileSync(fileURLToPath(new URL('../styles.css', import.meta.url)), 'utf8');

    expect(inspector).toContain('window.cortexlume.project.reveal(projectPath)');
    expect(inspector).toContain('className="project-file-path is-clickable"');
    expect(styles).toContain('.project-file-path.is-clickable');
    expect(styles).toContain('cursor: pointer');
    expect(styles).not.toMatch(/\.project-file-path[^}]*text-decoration:\s*underline/s);
  });
});

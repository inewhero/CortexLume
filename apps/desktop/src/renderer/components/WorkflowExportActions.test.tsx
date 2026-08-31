// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowExportActions } from './WorkflowExportActions';

afterEach(cleanup);

describe('Workflow export actions', () => {
  it('keeps AtlasViewer local while BIDS still requests atlas annotation', () => {
    const inspector = readFileSync(path.join(process.cwd(), 'src', 'renderer', 'components', 'Inspector.tsx'), 'utf8');
    const bidsStart = inspector.indexOf('const exportBids = async () => {');
    const atlasViewerStart = inspector.indexOf('const exportAtlasViewer = async () => {', bidsStart);
    const atlasViewerEnd = inspector.indexOf('const importDigitizer = async () => {', atlasViewerStart);
    expect(bidsStart).toBeGreaterThan(0);
    expect(atlasViewerStart).toBeGreaterThan(bidsStart);
    expect(atlasViewerEnd).toBeGreaterThan(atlasViewerStart);

    const bidsHandler = inspector.slice(bidsStart, atlasViewerStart);
    expect(bidsHandler).toContain('science.annotateProject(snapshot, options)');
    expect(bidsHandler).toContain('export.bidsGeometry(annotated, options)');

    const atlasViewerHandler = inspector.slice(atlasViewerStart, atlasViewerEnd);
    expect(atlasViewerHandler).toContain('if (!hasExportableInstance)');
    expect(atlasViewerHandler).toContain('AtlasViewer export requires a patch in 3D Align.');
    expect(atlasViewerHandler).toContain('materializeProjectionSnapshot(project)');
    expect(atlasViewerHandler).not.toContain('annotateProject');
    expect(atlasViewerHandler).toContain('export.atlasViewer(snapshot, options)');
    expect(atlasViewerHandler).toContain('result.atlasViewer.scriptOpened');
    expect(atlasViewerHandler).toContain('opened the AtlasViewer MATLAB bridge');
    expect(atlasViewerHandler).toContain("setProjectOperation({ operationId: options.operationId!, operation: 'export'");
    expect(atlasViewerHandler).toContain('setProjectOperation((current) =>');
  });

  it('renders one two-column grid in the required row-major order', () => {
    const callbacks = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    render(<WorkflowExportActions
      disabled={false}
      onCsv={callbacks[0]!}
      onBids={callbacks[1]!}
      onBrainNet={callbacks[2]!}
      onAtlasViewer={callbacks[3]!}
    />);

    const group = screen.getByRole('group', { name: 'Export formats' });
    expect(group).toHaveClass('project-actions', 'export-actions');
    const stylesheet = readFileSync(path.join(process.cwd(), 'src', 'renderer', 'styles.css'), 'utf8');
    expect(stylesheet).toMatch(/\.project-actions\.export-actions\s*\{[^}]*grid-template-columns:\s*repeat\(2,/s);
    const buttons = within(group).getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual(['CSV', 'BIDS', 'BrainNet', 'AtlasViewer']);
    buttons.forEach((button, index) => {
      fireEvent.click(button);
      expect(callbacks[index]).toHaveBeenCalledOnce();
    });
  });

  it('disables all four actions together and exposes the scientific gate reason', () => {
    render(<WorkflowExportActions
      disabled
      disabledReason="Verified HeadModel surfaces are required"
      onCsv={vi.fn()}
      onBids={vi.fn()}
      onBrainNet={vi.fn()}
      onAtlasViewer={vi.fn()}
    />);
    for (const button of screen.getAllByRole('button')) {
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', 'Verified HeadModel surfaces are required');
    }
  });
});

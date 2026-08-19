// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TargetImportResult } from '@cortexlume/contracts';
import { TargetMapImportDialog } from './TargetMapImportDialog';

const accepted: TargetImportResult = {
  accepted: true,
  declaredSpace: 'NeurosynthMNI152-2mm',
  recognizedSpace: 'NeurosynthMNI152-2mm-FSL-LAS',
  shape: [91, 109, 91],
  affine: [[-2, 0, 0, 90], [0, 2, 0, -126], [0, 0, 2, -72], [0, 0, 0, 1]],
  units: 'mm', valueMin: 0, valueMax: 6.2, nonzeroVoxels: 1234, sha256: 'a'.repeat(64),
  diagnostics: [{ severity: 'warning', code: 'legacy', message: 'Exact legacy grid.', action: 'Keep provenance.' }],
  map: {
    target: { id: 'nifti:aaaa', label: 'Working memory', aliases: [], peakRegions: [] },
    vertexCount: 25_000, vertexIndices: [11, 27], values: [2.1, 6.2],
    provenance: {
      sourceKind: 'nifti-import', sourceSpace: 'NeurosynthMNI152-2mm', targetSpace: 'MNI152NLin6Asym',
      targetSurface: 'Cedalion-ICBM152-25k', statistic: 'continuous-statistic', mapSha256: 'a'.repeat(64),
      fileName: 'working-memory.nii.gz',
    },
  },
};

describe('TargetMapImportDialog', () => {
  afterEach(cleanup);

  it('requires an explicit template before opening the system file dialog', () => {
    render(<TargetMapImportDialog importMap={vi.fn()} onApply={vi.fn()} onClose={vi.fn()} onToast={vi.fn()} />);
    const choose = screen.getByRole('button', { name: /choose .nii/i });
    expect(choose).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Template space'), { target: { value: 'NeurosynthMNI152-2mm' } });
    expect(choose).toBeEnabled();
    expect(screen.getByText(/4d images, atlases/i)).toBeInTheDocument();
    expect(screen.queryByText(/2009c.*select/i)).not.toBeInTheDocument();
  });

  it('shows structured validation before applying the mapped target', async () => {
    const importMap = vi.fn().mockResolvedValue(accepted);
    const onApply = vi.fn();
    const onClose = vi.fn();
    render(<TargetMapImportDialog importMap={importMap} onApply={onApply} onClose={onClose} onToast={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Template space'), { target: { value: 'NeurosynthMNI152-2mm' } });
    fireEvent.click(screen.getByRole('button', { name: /choose .nii/i }));

    expect(await screen.findByText('READY TO IMPORT')).toBeInTheDocument();
    expect(screen.getByText('91 × 109 × 91 · mm')).toBeInTheDocument();
    expect(importMap).toHaveBeenCalledWith('NeurosynthMNI152-2mm');
    fireEvent.click(screen.getByRole('button', { name: 'USE TARGET' }));
    await waitFor(() => expect(onApply).toHaveBeenCalledWith(accepted.map));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

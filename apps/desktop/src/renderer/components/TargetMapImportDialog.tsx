import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { FunctionalTargetMap, TargetImportResult, TargetImportSpace } from '@cortexlume/contracts';

export interface TargetMapImportDialogProps {
  importMap(declaredSpace: TargetImportSpace): Promise<TargetImportResult | null>;
  onApply(map: FunctionalTargetMap): void;
  onClose(): void;
  onToast(message: string): void;
}

const TEMPLATE_OPTIONS: Array<{ value: TargetImportSpace; label: string; note: string }> = [
  {
    value: 'MNI152NLin6Asym',
    label: 'MNI152NLin6Asym · CortexLume 1 mm',
    note: 'Exact 182 × 218 × 182 RAS+ grid. Preferred for new exports.',
  },
  {
    value: 'NeurosynthMNI152-2mm',
    label: 'MNI152 · FSL / legacy Neurosynth 2 mm',
    note: 'Exact 91 × 109 × 91 FSL-LAS or CortexLume RAS-equivalent grid.',
  },
];

export function TargetMapImportDialog({ importMap, onApply, onClose, onToast }: TargetMapImportDialogProps) {
  const [declaredSpace, setDeclaredSpace] = useState<TargetImportSpace | ''>('');
  const [result, setResult] = useState<TargetImportResult | null>(null);
  const [targetName, setTargetName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [busy, onClose]);

  const chooseMap = async () => {
    if (!declaredSpace) return;
    setBusy(true);
    setResult(null);
    try {
      const imported = await importMap(declaredSpace);
      if (imported) {
        setResult(imported);
        setTargetName(imported.map?.target.label ?? '');
      }
    } catch (error) {
      onToast(`Target import error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const selectedTemplate = TEMPLATE_OPTIONS.find((option) => option.value === declaredSpace);
  const fileName = result?.map?.provenance.fileName;

  return createPortal(
    <div className="target-import-scrim" role="presentation" onPointerDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <section className="target-import-dialog" role="dialog" aria-modal="true" aria-labelledby="target-import-title">
        <header>
          <div><strong id="target-import-title">IMPORT TARGET MAP</strong><span>VOLUMETRIC NIFTI</span></div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close">×</button>
        </header>

        <div className="target-import-body">
          <div className="target-import-step">
            <b>01</b>
            <label><span>TEMPLATE SPACE</span>
              <select aria-label="Template space" value={declaredSpace} onChange={(event) => {
                setDeclaredSpace(event.target.value as TargetImportSpace | '');
                setResult(null);
              }}>
                <option value="">SELECT THE MAP'S TEMPLATE</option>
                {TEMPLATE_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
              </select>
            </label>
          </div>
          {selectedTemplate && <p className="target-template-note">{selectedTemplate.note}</p>}

          <div className={`target-import-step ${declaredSpace ? '' : 'is-disabled'}`}>
            <b>02</b>
            <div className="target-system-file">
              <span>STATISTICAL MAP</span>
              <button type="button" onClick={() => void chooseMap()} disabled={!declaredSpace || busy}>
                {busy ? 'VALIDATING HEADER AND MAPPING…' : 'CHOOSE .NII / .NII.GZ'}
              </button>
              {fileName && <code title={fileName}>{fileName}</code>}
            </div>
          </div>

          <div className="target-import-guidance">
            <strong>ACCEPTED INPUT</strong>
            <p>One 3D continuous statistical volume with a valid qform or sform, a locked template affine and millimetre units. Positive cortical values define the displayed target.</p>
            <p>4D images, atlases, label maps, CIFTI/fsaverage files, Talairach and subject-native images are rejected.</p>
            <p>MNI152NLin2009cAsym becomes available only in builds carrying its verified official transform.</p>
          </div>

          {result && <div className={`target-validation ${result.accepted ? 'is-valid' : 'is-invalid'}`}>
            <div className="target-validation-summary">
              <strong>{result.accepted ? 'READY TO IMPORT' : 'IMPORT BLOCKED'}</strong>
              <code>{result.shape?.join(' × ') ?? '—'} · {result.units ?? '—'}</code>
            </div>
            {result.diagnostics.map((item) => <div className={`target-diagnostic is-${item.severity}`} key={item.code}>
              <b>{item.severity.toUpperCase()}</b><div><strong>{item.message}</strong>{item.action && <span>{item.action}</span>}</div>
            </div>)}
            {result.accepted && <dl>
              <dt>TARGET NAME</dt><dd><input aria-label="Target name" value={targetName} maxLength={100} onChange={(event) => setTargetName(event.target.value)} /></dd>
              <dt>RECOGNIZED SPACE</dt><dd>{result.recognizedSpace}</dd>
              <dt>VALUE RANGE</dt><dd>{result.valueMin?.toPrecision(4)} — {result.valueMax?.toPrecision(4)}</dd>
              <dt>NON-ZERO VOXELS</dt><dd>{result.nonzeroVoxels?.toLocaleString()}</dd>
              <dt>SHA-256</dt><dd title={result.sha256 ?? undefined}>{result.sha256?.slice(0, 16)}…</dd>
            </dl>}
          </div>}
        </div>

        <footer>
          <button type="button" onClick={onClose} disabled={busy}>CANCEL</button>
          <button type="button" className="primary" disabled={!result?.accepted || !result.map || busy} onClick={() => {
            if (!result?.map) return;
            onApply({
              ...result.map,
              target: {
                ...result.map.target,
                label: targetName.trim() || result.map.target.label,
              },
            });
            onClose();
          }}>USE TARGET</button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

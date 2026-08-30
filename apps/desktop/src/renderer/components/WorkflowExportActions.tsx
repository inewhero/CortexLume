interface WorkflowExportActionsProps {
  disabled: boolean;
  disabledReason?: string | null;
  onCsv(): void;
  onBids(): void;
  onBrainNet(): void;
  onAtlasViewer(): void;
}

export function WorkflowExportActions({
  disabled,
  disabledReason,
  onCsv,
  onBids,
  onBrainNet,
  onAtlasViewer,
}: WorkflowExportActionsProps) {
  const title = (format: string) => disabledReason ?? `Export ${format} geometry`;
  return (
    <div className="project-actions export-actions" role="group" aria-label="Export formats">
      <button disabled={disabled} title={title('CSV')} onClick={onCsv}>CSV</button>
      <button disabled={disabled} title={title('BIDS')} onClick={onBids}>BIDS</button>
      <button disabled={disabled} title={title('BrainNet')} onClick={onBrainNet}>BrainNet</button>
      <button disabled={disabled} title={title('AtlasViewer')} onClick={onAtlasViewer}>AtlasViewer</button>
    </div>
  );
}

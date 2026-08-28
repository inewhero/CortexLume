# Projects and Exports

## Save an editable project

Set a clear **Project Name**, then choose **Info Panel → Workflow → Project → Save**. CortexLume writes a `.cortexlume` archive containing editable layouts, independent 3D patch instances, projection settings, functional targets, digitizer sessions, device settings, and planning provenance.

Use **Open** to restore a project and **New** to start again. CortexLume prompts before replacing unsaved work. When an older supported project format is opened, the application migrates it in memory; saving creates the current format.

Keep `.cortexlume` as the master design file. Exports are downstream snapshots and cannot replace the editable project.

## CSV export

Choose **Export → CSV** and select an output folder. CortexLume writes:

- `cortexlume_optodes.csv`: clear Source/Detector coordinates and results;
- `cortexlume_channels.csv`: channel geometry, actual spacing, target coordinates, and leading region probabilities;
- `cortexlume_export.json`: template, assets, projection provenance, digitizer records, QC, and other technical metadata.

CSV uses concise analysis-facing columns. Detailed validation and provenance remain in the JSON sidecar.

## BIDS-NIRS geometry export

Expand **Device** in **Optode Design** and complete the dataset entities and instrument profile. The panel includes subject, optional session, task, optional acquisition and run, manufacturer, model, wavelengths, legal measurement type, units, and sampling frequency.

Choose **Export → BIDS**. If a required value is missing, CortexLume expands **Device**, highlights the fields, and reports them in the notification bubble. A successful export creates BIDS-style `optodes.tsv`, `channels.tsv`, and `coordsystem.json` files plus a technical CortexLume JSON under `sourcedata`.

This is a geometry export for integration with an fNIRS recording dataset. It does not invent measurement time series or event data.

## BrainNet Viewer export

Choose **Export → BrainNet**. CortexLume writes:

- `cortexlume_brainnet.node` with cortical MNI optode coordinates and distinct Source/Detector classes;
- `cortexlume_open_brainnet.m`, a MATLAB launcher;
- the same concise optode/channel CSV files and technical JSON;
- a short README for the bundle.

No edge file is generated. Node labels are present but hidden by default. If MATLAB and BrainNet Viewer are available on the MATLAB path, CortexLume attempts to launch the result automatically; otherwise the files remain ready to open by running `cortexlume_open_brainnet.m` in MATLAB.

## Before exporting

- Load at least one visible patch into **3D Align**.
- Wait for the verified anatomical surfaces to finish loading.
- Check Scalp/Cortex projection, actual spacing, overlaps, and selected region results.
- Confirm digitizer correspondence when measured geometry is part of the study.
- Save the `.cortexlume` project before or after export so the exact design remains editable.

Long annotation or export operations show progress in **Workflow** and provide **Cancel**. Output is written only after the requested operation completes.

Return to the [User Guide home](Home.md).

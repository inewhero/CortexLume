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

## AtlasViewer probe export

Choose **Export → AtlasViewer** to write:

- `cortexlume_atlasviewer.SD`: an uncompressed MATLAB v5 file containing the AtlasViewer/Homer `SD` structure;
- `cortexlume_open_atlasviewer.m`: a bridge to open the exported subject directory after AtlasViewer's paths are configured;
- `cortexlume_atlasviewer.json`: the source/detector/channel index mapping, coordinate semantics, calibration provenance, and warnings;
- `README_ATLASVIEWER.txt`: concise import and registration guidance.

### Recommended AtlasViewer workflow

AtlasViewer installations are often tied to a particular MATLAB release, commonly MATLAB R2017b. CortexLume therefore does not assume that the MATLAB used for other work can run AtlasViewer, and it never executes AtlasViewer automatically.

1. In CortexLume, load the patch in **3D Align** and wait for verified surface projection results.
2. If measured digitizer data are available, complete and inspect the five-point calibration before export.
3. Choose **Export → AtlasViewer** and select a parent folder. CortexLume creates a unique `CortexLume_AtlasViewer_Export` folder and opens `cortexlume_open_atlasviewer.m` for review.
4. Start the MATLAB release required by your AtlasViewer installation.
5. Run AtlasViewer's `setpaths.m` so that `AtlasViewerGUI` and its probe modules are on the MATLAB path.
6. Run `cortexlume_open_atlasviewer.m`. The bridge opens AtlasViewer on the exported subject folder, whose only `.SD` file is `cortexlume_atlasviewer.SD`.
7. Inspect the optode and landmark alignment in AtlasViewer, complete registration when required, and only then continue to head modelling or photon simulation.

Opening the bridge from CortexLume is not the same as running it: the desktop application hands the `.m` file to its associated editor and leaves execution to the user. You can also bypass the bridge and import `cortexlume_atlasviewer.SD` through AtlasViewer's probe workflow.

### Geometry carried by the SD file

`SrcPos3D` and `DetPos3D` contain CortexLume's verified scalp optode sphere-centre coordinates in MNI152NLin6Asym RAS+ millimetres. The required `SrcPos` and `DetPos` fields mirror the same three-dimensional coordinates; they are not a lossy two-dimensional projection. `MeasList` contains one-based source, detector, data-type, and wavelength indices for every exported channel and configured wavelength.

All non-superseded 3D patch instances are combined into one probe with stable, globally indexed sources and detectors. Use `cortexlume_atlasviewer.json` to map those indices back to CortexLume instance, optode, and channel identifiers.

When every exported patch shares one complete five-point calibration, CortexLume includes those template-space landmarks in `Landmarks3D`. Otherwise the file still contains the verified probe geometry, but `Landmarks3D` is empty and registration must be completed in AtlasViewer. In both cases, inspect and approve the AtlasViewer alignment before analysis: the export does not claim subject-specific registration and does not embed CortexLume cortical-contact coordinates, depth targets, or atlas labels as unofficial SD fields.

### If the bridge reports an error

- **`AtlasViewerGUI is not on the MATLAB path`**: run the `setpaths.m` supplied with the AtlasViewer installation, then run the bridge again in the same MATLAB session.
- **Probe modules are not on the MATLAB path**: confirm that the full AtlasViewer distribution, rather than only its launcher, was added by `setpaths.m`.
- **The SD file is missing**: keep the bridge and `cortexlume_atlasviewer.SD` together in the generated export folder; do not move only the `.m` file.
- **No landmarks appear**: the exported instances did not share one complete five-point calibration. Register the probe in AtlasViewer using the subject's landmarks.
- **MATLAB compatibility errors**: reopen the bundle with the MATLAB release expected by that AtlasViewer installation. CortexLume writes a MATLAB Level-5 file specifically to keep the interchange independent of current MATLAB-only file features.

## Before exporting

- Load at least one visible patch into **3D Align**.
- Wait for the verified anatomical surfaces to finish loading.
- Check Scalp/Cortex projection, actual spacing, overlaps, and selected region results.
- Confirm digitizer correspondence when measured geometry is part of the study.
- Save the `.cortexlume` project before or after export so the exact design remains editable.

Long annotation or export operations show a progress bubble in **3D Align** and provide **Cancel**. Output is written only after the requested operation completes.

## Export with an AI Agent

The desktop controls above are the human-facing workflow. A connected local Agent can instead call `export_brainnet` or `export_atlasviewer` for an existing `.cortexlume` project, provided that both the project and chosen output directory are inside MCP-authorized roots.

Each tool creates a uniquely named folder without overwriting previous output and returns the created directory, files, and warnings. Headless export does not launch MATLAB or BrainNet Viewer, and it does not execute or open the AtlasViewer MATLAB bridge. See the [BrainNet export example](Working-with-an-AI-Agent#brainnet-export-example), [AtlasViewer export example](Working-with-an-AI-Agent#atlasviewer-export-example), and the repository [Agent Guide](https://github.com/inewhero/CortexLume/blob/main/AGENT_README.md#export-for-downstream-tools) for the machine-facing contract.

Return to the [User Guide home](Home).

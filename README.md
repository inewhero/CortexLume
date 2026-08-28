<div align="center">
  <img src="./apps/desktop/assets/icon.png" alt="CortexLume" width="100" height="100">
</div>

# CortexLume

[![Latest release](https://img.shields.io/github/v/release/inewhero/CortexLume?display_name=tag&sort=semver)](https://github.com/inewhero/CortexLume/releases/latest)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/inewhero/CortexLume)

CortexLume is an offline Windows workstation for designing fNIRS source–detector layouts, placing reusable patches on an anatomical head model, checking cortical targets, and exporting reproducible MNI-space results.

## Install

Download and run `CortexLume-*-win-x64-Setup.exe` from the [latest release](https://github.com/inewhero/CortexLume/releases/latest). The optional `CortexLume-*-examples.zip` contains ready-to-open projects and input files for learning the main workflows without changing the application install.

AI agents use CortexLume through its local MCP interface. Installation, connection, and planning instructions are kept separately in the [Agent Guide](./AGENT_README.md).

## Core workflow

1. **Choose a target.** Load a literature-derived Quick Target or import a compatible NIfTI statistical map.
2. **Design the array.** Draw an S/D layout or generate a regular matrix, then adjust optodes, channels, spacing, and numbering in 2D.
3. **Place the patch.** Drag one or more reusable patches into the 3D workspace and align them on the scalp.
4. **Check the anatomy.** Inspect functional targeting, projection results, cortical regions, anatomical coverage, and cross-patch overlap.
5. **Validate acquired geometry.** Import digitizer data and use five-point calibration to compare measured and planned optodes.
6. **Save or export.** Preserve the editable project as `.cortexlume`, or export CSV/JSON, BIDS-NIRS, and BrainNet Viewer files.

## Functional targeting

Quick Target maps curated Neurosynth association statistics onto the Cedalion 25k cortical surface. CortexLume also accepts validated `.nii` and `.nii.gz` statistical maps from workflows such as Compose, NiMARE, SPM, FSL, and NeuroVault. The active target appears as a controllable Functional Map layer in the 3D workspace.

![Quick Target guided layout](./screenshots/ScreenShot_music_target.png)

## Layout design and 3D alignment

The 2D editor provides fine and coarse grid snapping, regular matrix generation, S/D reversal, channel solving, direct channel numbering, zoom, and reusable patch storage. The 3D workspace supports independent multi-patch placement, mapping rotation, local optode adjustment, overlap warnings, scalp and cortical projection, and selectable anatomy layers.

![Array design](./screenshots/ScreenShot_array_design.png)

![3D alignment](./screenshots/ScreenShot_omni.png)

## Anatomical coverage

Anatomical Coverage shows the Harvard–Oxford cortical regions intersected by the visible channel geometry. Use **Overall Mosaic** to inspect the regional distribution of an array or **Single Region** to isolate one target area.

![Anatomical coverage](./screenshots/ScreenShot_coverage.png)

## Digitizer validation

CortexLume imports common MNE, Polhemus, EEG, CSV, TSV, JSON, and MATLAB coordinate data. Five-point calibration maps measured geometry to the template head, while the correspondence editor makes planned-to-measured optode matching visible and reviewable before the calibrated layout is stored as a new patch.

The optional [example dataset](./examples/README.md) includes a placed starter project, a complex irregular patch, interactive five-point calibration, full-array digitizer matching, and NIfTI target mapping.

## Projects and exports

- `.cortexlume` archives preserve layouts, patch instances, functional targets, device settings, calibration data, and planning provenance.
- CSV files contain clear optode and channel results; the companion technical JSON contains reproducibility metadata.
- BIDS-NIRS export prepares standardized geometry and coordinate-system sidecars for downstream recording datasets.
- BrainNet export creates node data and a MATLAB launcher for anatomical visualization.

## Scientific foundation

CortexLume uses pinned MNI152NLin6Asym, Cedalion ICBM152, Cedalion 25k surface-correspondence, and Harvard–Oxford probability-atlas assets. The same correspondence-backed geometry drives targeting, projection, atlas lookup, coverage, desktop interaction, and Agent planning.

Scientific assets are integrity-checked during build and at runtime. Reproducible asset preparation and validation are documented in [SCIENTIFIC_ASSET_PIPELINE.md](./docs/SCIENTIFIC_ASSET_PIPELINE.md), [Quick Target data](./docs/quick-target-data.md), and the [Quick Target QC report](./docs/quick-target-qc-v1.md).

## Development

Requirements: Node.js 24, pnpm 10, and Python 3.12.

```powershell
pnpm install
py -3.12 -m venv .venv
.\.venv\Scripts\python -m pip install -e "services/science[dev]"
$env:CORTEXLUME_PYTHON = "$PWD\.venv\Scripts\python.exe"
pnpm dev
```

Run checks with:

```powershell
pnpm typecheck
pnpm test
pnpm build
```

Create the Windows installer and portable package with `pnpm package:win`. Build artifacts are written under `apps/desktop/out/make`.

## License

CortexLume source code is released under the permissive [MIT License](LICENSE). Bundled scientific assets retain their upstream licenses and attribution requirements; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

<div align="center">
  <img src="./apps/desktop/assets/icon.png" alt="CortexLume" width="100" height="100">
</div>

# CortexLume

CortexLume is an offline Electron workstation for designing fNIRS source-detector layouts, placing reusable layout patches on an anatomical head model, and reporting scalp and cortical coordinates in MNI space.

The application includes a high-density 2D matrix editor, channel solver and numbering table, layered scalp/gray-matter/white-matter rendering, five-point registration landmarks, 10–10 reference positions, reusable patch placement, project persistence, and CSV/BIDS geometry output.

## Features

### 2D Matrix Editor & Array Design
Design and edit high-density fNIRS source-detector arrays with an intuitive matrix interface.

![Array Design](./screenshots/ScreenShot_array_design.png)

### Single Channel Modification
Precisely modify individual channels and source-detector pairs with real-time feedback.

![Single Modification](./screenshots/ScreenShot_sigle_modify.png)

### Omnidirectional Head Model Visualization
View and interact with your layout on a 3D anatomical head model with multiple viewing angles and cortical surface rendering.

![Omnidirectional View](./screenshots/ScreenShot_omni.png)

### Project Simulation & Validation
Simulate and validate your fNIRS layout design, verify channel coverage, and check for conflicts.

![Project Simulation](./screenshots/ScreenShot_project_simulate.png)

## How to use

1. **Design an array.** Build an S/D pattern in **Optode Design**, or generate an `x × y` grid as a starting point. Adjust optode positions, reverse source and detector roles, and edit channel numbers directly.
2. **Place it on the head.** Drag the finished layout into **3D Align**. Add multiple patches when the study requires broader or bilateral coverage.
3. **Align each patch.** Select a patch, move it across the scalp, and use the rotation controls to match the intended anatomical position. Switch to single-optode editing for local adjustments.
4. **Choose the projection.** Use **Scalp** to position optodes on the head surface, or **Cortex** to project them to their first gray-matter contact. Set a depth when deeper target estimates are needed.
5. **Inspect the result.** Select an optode or channel to review scalp and cortical MNI coordinates, cortical-region probabilities, channel spacing, deep structures, and QC information. Layer controls can isolate the scalp, gray matter, white matter, landmarks, and channel labels.
6. **Save or export.** Save the complete workspace as a `.cortexlume` project for later editing. Export CSV for linked layout, optode, channel, coordinate, anatomical, and QC tables, or export BIDS-compatible geometry files for downstream workflows.

## Development

Requirements: Node.js 24, pnpm 10, and Python 3.12.

```powershell
pnpm install
py -3.12 -m venv .venv
.\.venv\Scripts\python -m pip install -e "services/science[dev]"
$env:CORTEXLUME_PYTHON = "$PWD\.venv\Scripts\python.exe"
pnpm dev
```

Run checks with `pnpm typecheck`, `pnpm test`, and `pnpm build`.

## Windows distribution

Build the PyInstaller science service, packaged application, Squirrel installer,
and portable ZIP with:

```powershell
pnpm package:win
```

Artifacts are written under `apps/desktop/out/make`. See
`docs/SCIENTIFIC_ASSET_PIPELINE.md` for the reproducible anatomical asset
contract and validation process.

## License

CortexLume source code is released under the permissive [MIT License](LICENSE).
Bundled anatomical templates and other scientific assets retain their upstream
licenses and attribution requirements; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

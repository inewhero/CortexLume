# CortexLume for AI agents

CortexLume gives AI agents a local MCP interface for planning fNIRS layouts, writing complete `.cortexlume` projects, checking rendered anatomy, and creating downstream export bundles. The desktop application then opens those projects for human visual review and adjustment.

## Install and connect

1. Download `CortexLume-*-win-x64-Setup.exe` from the latest stable release at <https://github.com/inewhero/CortexLume/releases/latest>.
2. Run the installer, complete the per-user Windows installation, and locate the installed `CortexLume.exe` for MCP configuration.
3. Ask the user which project folders CortexLume may read and write.
4. Add CortexLume to the current client's MCP configuration as a stdio server:

```text
command: C:\Path\To\CortexLume.exe
args:
  - --mcp-stdio
  - --mcp-root=D:\authorized-projects
```

Add one `--mcp-root=<absolute-path>` argument for each user-approved root. Use the MCP configuration mechanism native to the current client. Do not start an HTTP server or grant broader filesystem access.

Restart or reconnect the MCP client after changing its configuration. A successful MCP launch creates no CortexLume window and writes only protocol messages to stdout.

## Start a planning task

Use the tools in this order:

1. `get_capabilities` — confirm that the bundled template, mesh, atlas, and planning assets are ready.
2. `list_targets` — read the complete compact Quick Target catalog before searching.
3. `search_targets` or `list_atlas_regions` — resolve the user's intended target when needed.
4. `plan_project` — request three deterministic candidates for an explicit target and patch specification.
5. Present the candidate scores and recommendation to the user.
6. `save_project` — write the selected candidate to a new `.cortexlume` file; success consumes the plan unless `consumePlan: false` is explicitly requested.
7. `release_plan` — release a cached plan early when it is no longer needed.
8. `capture_project_screenshot` — optionally render a deterministic transparent scientific PNG for an Agent visual check.
9. `export_brainnet` or `export_atlasviewer` — optionally create a unique downstream bundle from an authorized saved project.
10. `open_project` — open that file in a separate CortexLume window for human inspection.

`inspect_project` can audit an existing project before deriving a new plan. CortexLume never overwrites an existing project path.

## Generate a visual-check screenshot

`capture_project_screenshot` requires an authorized saved project. By default it writes a unique transparent PNG under `CortexLume_Screenshots/` beside that project; any custom output path must also be inside an authorized MCP root. Background, ground grid, and application UI are always excluded. The result includes the saved path, physical dimensions, effective scientific layers, project hash, and resolved camera.

This tool does not reuse or claim the current view of an independently open CortexLume window. Use a deterministic camera preset (`gui-default`, `front`, `left`, `right`, or `superior`) or an explicit pose with `position`, `target`, `up`, and `fov`. Explicit vectors are CortexLume 3D scene millimetres: `[x, y, z] = [RAS right, RAS superior, -RAS anterior]`. The default layer request follows the project's saved functional or anatomical-coverage overlay while preserving project-level visibility for individual patch and digitizer instances.

PNG pixels are native, non-quantized RGBA8. Standard PNG DEFLATE is lossless; no lossy image compression is applied. The screenshot worker is an isolated hidden Electron renderer launched only for the bounded capture, and its stdout is never forwarded into the MCP stdio protocol.

## Export for downstream tools

`export_brainnet` and `export_atlasviewer` operate headlessly on an existing `.cortexlume` project. Pass `{ projectPath, outputDirectory }`; both must resolve inside authorized roots, and `outputDirectory` must already exist. An optional `directoryName` may select the bundle name when it matches `[A-Za-z0-9][A-Za-z0-9 _-]{0,127}`. Otherwise the defaults are `CortexLume_BrainNet` and `CortexLume_AtlasViewer`.

CortexLume atomically reserves a unique folder, appending `-2`, `-3`, and so on when needed, and never overwrites an existing bundle. Success returns `{ exportKind, directory, files, warnings, headless, project }`; each `files` item contains its `name` and absolute `path`, while `project` identifies the validated source path, project ID, and archive SHA-256.

Use `export_brainnet` for BrainNet Viewer node, CSV, metadata, README, and MATLAB launcher files. MCP mode only writes the bundle: it does not start MATLAB or BrainNet Viewer.

Use `export_atlasviewer` for the MATLAB v5 `.SD` probe, mapping metadata, README, and `cortexlume_open_atlasviewer.m` bridge. MCP mode does not execute or open the bridge. Return its path to the user and instruct them to open it in a compatible MATLAB/AtlasViewer environment; AtlasViewer commonly depends on its own MATLAB release and setup path.

Before exporting, confirm that `get_capabilities` reports the requested item under `exports` as available. Both tools return `headless: true`; do not claim that an external application was launched.

Example Agent sequence:

```text
Inspect D:\authorized-projects\study.cortexlume. Export it with export_brainnet
and export_atlasviewer into D:\authorized-projects\exports. Return every created
folder and file, report warnings, and do not launch MATLAB or overwrite anything.
```

These headless semantics are intentionally separate from the desktop buttons. The GUI may offer human-facing launch or file-opening assistance after an interactive export.

## Planning inputs

Targets may be a Quick Target ID, an exact Harvard–Oxford cortical region, an RAS+ MNI point, or an authorized local `.nii`/`.nii.gz` map.

Patch geometry must be explicit. If the user gives no alternative, use one 5 × 3 patch with 30 mm pitch, a Source in the upper-left cell, alternating S/D roles, 25–40 mm long channels, and no short channels. Ask before choosing multiple patches or a different topology.

For example:

```text
Plan one 5 × 3, 30 mm patch for the Quick Target "visual".
Return three candidates, explain coverage and robustness, and save the user's
chosen candidate under D:\authorized-projects without overwriting existing files.
```

## Operating rules

- Treat `.cortexlume` as the handoff artifact; do not reproduce the planner with ad hoc coordinates.
- Use only MCP-authorized roots for NIfTI input, project output, screenshots, and downstream exports.
- Treat screenshot camera presets or explicit poses as deterministic render requests, not as the current camera of another GUI process.
- Stop if `get_capabilities` reports missing, altered, or failed scientific assets.
- Let `plan_project` perform mesh-aware projection, sphere collision, spacing, overlap, coverage, and robustness evaluation.
- Do not silently change the requested target, patch count, geometry, channel range, or short-channel count.
- Keep the final GUI review step: the Agent proposes the layout; the researcher approves and fine-tunes it.

## Open an existing project

The desktop executable also accepts a project path directly:

```powershell
& "C:\Path\To\CortexLume.exe" "D:\authorized-projects\study.cortexlume"
```

This opens a new desktop process and does not replace unsaved work in another CortexLume window.

# CortexLume for AI agents

CortexLume gives AI agents a local MCP interface for planning fNIRS layouts and writing complete `.cortexlume` projects. The desktop application then opens those projects for human visual review and adjustment.

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
8. `open_project` — open that file in a separate CortexLume window for human inspection.

`inspect_project` can audit an existing project before deriving a new plan. CortexLume never overwrites an existing project path.

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
- Use only MCP-authorized roots for NIfTI input and project output.
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

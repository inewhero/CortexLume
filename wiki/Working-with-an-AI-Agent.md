# Working with an AI Agent

CortexLume lets Claude Code, Codex, and other local MCP-capable agents plan an fNIRS array and create a complete `.cortexlume` project. The Agent prepares candidates with the same head model and scientific assets used by the desktop application; you then open the result in CortexLume for visual review and adjustment.

The intended handoff is simple:

> Describe the scientific target and array constraints → let the Agent generate and evaluate candidates → inspect the selected project in the CortexLume GUI.

## Install and connect

Send this prompt to your local coding agent:

```text
Install CortexLume for Windows and connect its local MCP server by following:
https://github.com/inewhero/CortexLume/blob/main/AGENT_README.md
```

The Agent Guide contains the client-specific MCP instructions. During setup, choose a dedicated project folder that CortexLume may read and write. The Agent should configure that folder as an authorized MCP root rather than requesting broad filesystem access.

CortexLume MCP runs locally through stdio. It does not start an HTTP service or bind the workflow to a particular model provider. Planning, inspection, and downstream export tools do not open a window. The screenshot tool starts one isolated hidden Electron renderer for the requested capture, closes it when the PNG is complete, and never writes renderer diagnostics to MCP stdout.

## Ask for a layout

A useful planning request states:

- the functional or anatomical target;
- the number and shape of patches;
- pitch and channel-distance requirements;
- whether short channels are needed;
- the authorized folder for the resulting project.

If no geometry is specified, CortexLume's standard planning default is one 5 × 3 patch with 30 mm pitch, alternating Sources and Detectors, 25–40 mm long channels, and no short channels.

### Quick Target example

```text
Use CortexLume to plan one 5 × 3, 30 mm patch for the Quick Target "visual".
Compare the three candidates, recommend the best coverage and robustness balance,
save it in D:\CortexLume-Projects, and open it for my review.
```

### Anatomical region example

```text
Use CortexLume to list the available Harvard–Oxford cortical regions, resolve my
request for the left precentral target, then plan one 5 × 3 patch. Explain the
three candidates before saving the recommended project.
```

### Local NIfTI example

```text
Use the NIfTI statistical map in D:\CortexLume-Projects\targets\task-z.nii.gz
as the CortexLume planning target. Validate it strictly, plan one 5 × 3 patch,
and save a new project without overwriting any existing file.
```

The NIfTI file and output location must both be inside an authorized MCP root.

### Visual-check screenshot example

```text
Inspect D:\CortexLume-Projects\pilot.cortexlume, then call
capture_project_screenshot with the front camera preset, the project's saved
surface overlay, and a 1200 × 900 logical viewport. Return the PNG path,
resolved camera, dimensions, and included layer metadata.
```

`capture_project_screenshot` renders the saved project in an isolated renderer. It cannot read or claim the current camera of a separate CortexLume window. Choose a deterministic preset (`gui-default`, `front`, `left`, `right`, or `superior`) or provide an explicit `position`, `target`, `up`, and field of view. Explicit vectors use CortexLume 3D scene coordinates in millimetres: X is RAS right, Y is RAS superior, and Z is negative RAS anterior. The result reports the resolved pose, so a later visual check is reproducible.

The default output is a unique PNG under `CortexLume_Screenshots/` beside the authorized project. A custom PNG path must also remain inside an authorized MCP root. Background and ground grid are always excluded and cannot be enabled by tool input. Layer input can select anatomy, scientific labels, visible patches/digitizer data, and either the project's saved functional/coverage overlay or an explicit supported overlay. Returned metadata states the effective layers and physical pixel dimensions.

### Derive from an existing project

```text
Inspect D:\CortexLume-Projects\pilot.cortexlume, summarize its target, patches,
projection, and planning record, then create a new derived project for the same
target with two explicitly separate patches. Keep the original file unchanged.
```

### BrainNet export example

```text
Inspect D:\CortexLume-Projects\pilot.cortexlume, then call export_brainnet with
D:\CortexLume-Projects\exports as the output directory. Return the unique bundle
directory, every generated file, and all warnings. Do not launch MATLAB.
```

The project and existing output directory must be inside authorized MCP roots. The tool creates a new, uniquely named folder without overwriting an earlier export. It writes the BrainNet node data, concise tables, metadata, README, and MATLAB launcher, but headless MCP mode does not start MATLAB or BrainNet Viewer.

### AtlasViewer export example

```text
Inspect D:\CortexLume-Projects\pilot.cortexlume, then call export_atlasviewer
with D:\CortexLume-Projects\exports as the output directory. Return the unique
bundle directory, .SD file, MATLAB bridge, metadata, README, and all warnings.
```

The project and existing output directory must be inside authorized MCP roots. The tool writes a uniquely named MATLAB v5 `.SD` probe bundle from verified scalp geometry. It does not execute or open `cortexlume_open_atlasviewer.m`; ask the researcher to open that bridge in their compatible MATLAB/AtlasViewer setup. This avoids assuming that the MCP host has AtlasViewer's expected MATLAB release or configured paths.

## Review the candidates

The Agent receives three deterministic candidates rather than one unexplained placement. Ask it to compare:

- target-mass coverage;
- robustness under small placement and rotation perturbations;
- optode clearance and cross-patch overlap;
- realized spacing and projection quality;
- the anatomical regions covered by the channels.

The recommended candidate is a strong default, not a substitute for scientific judgment. You may select another candidate when laterality, cap access, hair, hardware, or study-specific placement constraints make it more appropriate.

## Inspect the project in CortexLume

After the Agent saves the selected candidate, ask it to open the project. CortexLume launches a separate desktop window so an unsaved project in another window is not replaced.

Use this review checklist:

1. Confirm that the intended Quick Target, atlas region, MNI point, or NIfTI target is present.
2. Rotate the head and inspect every patch from anterior, posterior, lateral, and superior views.
3. Compare **Scalp** and **Cortex** projection and select representative optodes and channels.
4. Check actual channel spacing, optode clearance, overlap warnings, and anatomical coverage.
5. Move or rotate a patch when acquisition constraints require a practical adjustment.
6. Save the reviewed design as an editable `.cortexlume` project before exporting.

The Agent-generated planning record remains in the project for provenance. Manual GUI edits are ordinary project edits and should be saved under the study's chosen project name.

## What CortexLume guarantees at the Agent boundary

- The Agent can only use folders explicitly authorized as MCP roots.
- Missing, altered, or unavailable scientific assets stop planning instead of falling back to approximate geometry.
- Project saving creates a unique derived filename and never overwrites an existing project.
- Screenshot capture validates both the project and output against authorized roots, uses a deterministic camera contract, and creates a unique transparent PNG without overwriting.
- BrainNet and AtlasViewer export validate both paths, create unique no-overwrite bundle folders, and return generated paths and warnings without launching downstream applications.
- Layout projection, collision, overlap, coverage, and robustness checks use the shared CortexLume core.
- Opening an Agent project remains a human review step; CortexLume does not silently approve it on your behalf.

## Troubleshooting

### CortexLume tools do not appear

Restart or reconnect the Agent client after it changes the MCP configuration. Ask the Agent to call `get_capabilities` before planning.

### A path is rejected

The input or output is outside the authorized MCP roots. Move the file into the approved project folder or explicitly approve another narrow folder and update the MCP configuration.

### Planning stops on an asset check

Use the current official CortexLume release and reinstall it if necessary. Planning correctly stops when the installed head-model, cortical, atlas, or targeting assets do not pass integrity checks.

### The target is ambiguous

Ask the Agent to read the complete Quick Target catalog or list the legal Harvard–Oxford region names before searching. Confirm the selected target before it runs the planner.

### The project needs practical adjustment

Open it in CortexLume and edit the patch in **3D Align**. The MCP planner creates a scientifically evaluated starting point; the GUI is the final workspace for cap fit, hardware access, and researcher approval.

Continue with [Installation and First Launch](Installation-and-First-Launch), the [Example Dataset](Example-Dataset), or [Design and 3D Alignment](Design-and-3D-Alignment).

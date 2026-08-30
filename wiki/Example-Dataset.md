# Example Dataset

The optional CortexLume example dataset provides ready-to-open projects and matching input files for learning the main workflows. It is distributed separately from the application so the installer remains compact.

## Download and prepare

1. Open the [latest CortexLume release](https://github.com/inewhero/CortexLume/releases/latest).
2. Download `CortexLume-<version>-examples.zip`.
3. Extract the complete ZIP to a writable study or tutorial folder.
4. Open the extracted case folder and read its short `README.md` before opening the project.

The examples ZIP is tutorial data, not the application installer. Install CortexLume with `CortexLume-<version>-win-x64-Setup.exe` first.

Each case is self-contained. Its `.cortexlume` file is the editable project, while the `data/` folder contains the input or machine-readable source used by that example. Save experiments under a new project name so the supplied reference remains available.

## Recommended order

| Case | Learn this workflow | Start with |
| --- | --- | --- |
| `01-quick-start` | Inspect and edit a placed standard patch | `quick-start.cortexlume` |
| `02-irregular-patch` | Work with an asymmetric 25-optode layout | `irregular-patch.cortexlume` |
| `03-digitizer-five-point` | Repeat manual five-landmark calibration | `five-point-input.cortexlume` |
| `04-digitizer-polhemus` | Match a complete MNE/Polhemus digitizer array | `polhemus-input.cortexlume` |
| `05-nifti-functional-target` | Validate and map a NIfTI statistical target | `nifti-import-input.cortexlume` |

## 01 — Quick start

Open `quick-start.cortexlume`. A standard 5 × 3 patch with 30 mm pitch is already placed on the left frontoparietal scalp.

1. Rotate the head and inspect the patch from several angles.
2. Switch **Info Panel → Projection** between **Scalp** and **Cortex**.
3. Select an optode and a channel to inspect coordinates, distance, projection, and atlas results.
4. Move or rotate P01, edit the layout in **Optode Design**, then save a derived project.

`data/layout-spec.json` records the example's geometry and numbering convention.

## 02 — Complex irregular patch

Open `irregular-patch.cortexlume` to inspect a 25-optode asymmetric layout created from an active-cell mask.

1. Expand **Channel Index** and review the generated adjacent S–D pairs.
2. Move individual optodes in **Optode Design** and regenerate channels if required.
3. Choose **Store Current** in **Patch Library**.
4. Load a second independent instance into **3D Align** and verify that the two instances can be positioned separately.

`data/active-cell-mask.json` is the machine-readable source geometry.

## 03 — Manual five-point calibration

Open `five-point-calibrated.cortexlume` first if you want to inspect the completed result. The original P01 is hidden and its calibrated derivative is active.

To repeat the workflow:

1. Open `five-point-input.cortexlume`.
2. Choose **Info Panel → Workflow → Import → 5-Point**.
3. Set the coordinate unit to **mm** and map the calibration to P01.
4. Enter the Nz, Iz, LPA, RPA, and Cz rows from `data/five_points.tsv`.
5. Choose **Calibrate** and inspect the new derived patch in **Patch Library**.

The source patch is preserved and hidden rather than overwritten.

## 04 — MNE/Polhemus digitizer correspondence

`data/polhemus_full_array.eeg` contains five fiducials followed by 15 optode points in metres. Open `polhemus-calibrated.cortexlume` to inspect the completed reference result.

To repeat the import:

1. Open `polhemus-input.cortexlume`.
2. Choose **Info Panel → Workflow → Import → Digitizer** and select `polhemus_full_array.eeg`.
3. Confirm **m** as the coordinate unit.
4. Assign the first five points to Nz, Iz, LPA, RPA, and Cz.
5. Map the remaining 15 points to P01 and choose **Preview**.
6. Rotate the 3D view, inspect the white-to-red and white-to-blue correspondence lines, and use **Refresh** if needed.
7. Confirm only after every measured point has one correct optode assignment.

The headerless optode rows intentionally appear as `UNKNOWN`, matching a common Polhemus/MNE export pattern. CortexLume resolves their correspondence geometrically.

## 05 — NIfTI functional target

This case uses a synthetic continuous bilateral occipital z-statistic volume on the accepted legacy Neurosynth/FSL MNI152 2 mm grid. It demonstrates the import workflow; it is not a biological result.

Open `nifti-visual-target.cortexlume` to inspect the mapped reference project. Toggle **Info Panel → Anatomy Layers → Functional map** to compare the overlay with gray and white matter.

To repeat validation:

1. Open `nifti-import-input.cortexlume`.
2. Choose **Info Panel → Workflow → Import → NIfTI Map**.
3. Declare **MNI152 · FSL / legacy Neurosynth 2 mm**.
4. Select `data/bilateral_visual_target_z.nii.gz`.
5. Review the recognized grid, affine diagnostics, value range, and non-zero voxel count.
6. Choose **Use Target** when the dialog reports **Ready to Import**.

`data/target-metadata.json` records the grid, affine, and SHA-256 of the tutorial volume.

## Continue from the examples

Use the supplied projects as editable starting points, then save study-specific work as a new `.cortexlume` archive. Continue with [Design and 3D Alignment](Design-and-3D-Alignment), [Functional Targeting](Functional-Targeting), or [Digitizer and Five-Point Calibration](Digitizer-and-Five-Point-Calibration) for the complete workflow.

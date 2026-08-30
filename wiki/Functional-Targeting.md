# Functional Targeting

CortexLume supports one active functional target at a time. A Quick Target and an imported NIfTI map are mutually exclusive: loading a new target replaces the previous functional target.

## Quick Target

1. Expand **Quick Target** at the top of **Optode Design**.
2. Search for a cognitive term or a close synonym.
3. Select a result to load its literature-derived surface map.
4. Design and place the patch while comparing its channels with the heatmap in **3D Align**.

Quick Target uses the installed offline catalog of curated Neurosynth association-test maps. Results show the target label, category, study count, and laterality. **Change Target** returns to search; **Clear** removes the active target.

The visible heatmap is a surface guide, not a new patch. Its color scale appears in the 3D legend. Toggle **FMAP Functional map** in **Info Panel → Anatomy Layers** without deleting the target.

## Import a NIfTI target map

Choose **Info Panel → Workflow → Import → NIfTI Map**. The import dialog requires the map's template space before file selection:

- **MNI152NLin6Asym · CortexLume 1 mm**: exact 182 × 218 × 182 RAS+ grid;
- **MNI152 · FSL / legacy Neurosynth 2 mm**: exact 91 × 109 × 91 FSL-LAS grid or its accepted RAS-equivalent form.

Select one 3D continuous `.nii` or `.nii.gz` statistical volume. The file must have a valid qform or sform, millimetre units, the declared affine, and positive cortical values. CortexLume rejects 4D images, label atlases, CIFTI/fsaverage data, Talairach data, subject-native images, and unsupported template grids instead of guessing a transform.

Review the recognized space, dimensions, value range, non-zero voxel count, and diagnostics. Give the target a clear name and choose **Use Target** only when validation reports **Ready to Import**.

The project stores the mapped sparse Cedalion 25k surface target, source filename, hash, and provenance; it does not embed the original NIfTI volume. Keep the source volume with the study if it is needed outside CortexLume.

## Overlay behavior

The Functional Map layer can be viewed over gray matter or white matter. CortexLume maps the target to the anatomical surface rather than stacking a second anatomy mesh. Surface interpolation fills small sampling gaps while retaining a strict activation boundary.

Anatomical Coverage and the Functional Map are mutually exclusive display modes. Switching to coverage hides the heatmap but does not clear it; switch the Functional Map layer back on to restore it.

For a ready-made input, use the optional example dataset's `05-nifti-functional-target` case.

Next: [Digitizer and Five-Point Calibration](Digitizer-and-Five-Point-Calibration).

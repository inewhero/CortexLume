# NIfTI functional target

This case contains a continuous bilateral occipital z-statistic volume on the accepted legacy Neurosynth/FSL MNI152 2 mm grid.

1. Open `nifti-visual-target.cortexlume` to see the already mapped Functional Map layer on the Cedalion 25k surface.
2. Toggle **Info Panel → Anatomy Layers → Functional map** to compare the target with the anatomy.
3. To repeat validation, open `nifti-import-input.cortexlume`, choose **Info Panel → Workflow → NIfTI Map**, select `data/bilateral_visual_target_z.nii.gz`, and declare **Neurosynth MNI152 2 mm**.

The volume is synthetic tutorial data, not a biological result. `data/target-metadata.json` records its grid, affine and SHA-256.

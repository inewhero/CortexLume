# Scientific asset pipeline

The public coordinate target is strictly `MNI152NLin6Asym`, RAS+, millimetres. Cedalion's `icbm152` geometry includes explicit per-vertex MNI152 coordinates and a voxel-to-surface mapping. These upstream correspondences must be tested before introducing any newly estimated template registration.

## Locked inputs

- TemplateFlow `tpl-MNI152NLin6Asym`, resolution 1 T1w and brain mask.
- TemplateFlow repository commit `c906e8d808a34719e5024a4bde61f03a4e411ddd` for entity names and grid metadata.
- FSL 5.0 Harvard–Oxford `cortl-prob-1mm` and `sub-prob-1mm` authority volumes plus XML labels, distributed through NITRC download 9902. The probability files published by the locked TemplateFlow commit fail numerical validation (`HOCPAL` is empty and `HOSPA` peaks at 0.01), so they must not be queried.
- Cedalion 26.5.1 `hm_icbm152.zip`, SHA-256 `91bb99709b6ceadd41674acc0db6cf26d70dccb57e41797b474aa9ce6aeed3e8`, including `brain_vertex_coordinates.csv`, `voxel_to_vertex_brain.mtx.gz`, surfaces, tissue masks, landmarks, and their shared affine.

All downloaded inputs must be pinned by URL, version, license, and SHA-256 before preprocessing starts.

## Reproducible correspondence decision

1. Load Cedalion's `brain_vertex_coordinates.csv`, `voxel_to_vertex_brain.mtx.gz`, cortical surface, tissue masks, landmarks, and voxel-to-RAS affine as one version-locked correspondence set.
2. Verify row/index cardinality and test `mni152_r/a/s` against `mask_gray.nii affine × cortical vertices`. Report residual distributions and outliers; do not silently reorder vertices.
3. Establish the exact provenance and coordinate convention of Cedalion's named `MNI152` space from upstream metadata or maintainers.
4. Compare Cedalion and locked TemplateFlow `MNI152NLin6Asym` using grid/affine checks, five-point and 10–10 landmarks, sampled brain/scalp surfaces, and voxel correspondence fixtures.
5. If the coordinates are numerically the same space within declared tolerances, use the identity mapping and promote the correspondence gate. If they are distinct documented MNI variants, use a pinned authoritative template-to-template transform.
6. Estimate a new registration such as ANTs SyN only when no trustworthy existing mapping is available. Record its images, command, seed, RAS/LPS conversions, parameters, forward/inverse transforms, and QC.
7. Generate canonical scientific meshes and renderer GLBs without discarding the official Cedalion vertex and voxel correspondence. The invisible picking mesh must retain a traceable mapping to canonical vertices.
8. Losslessly flip the FSL first axis into TemplateFlow's positive-diagonal RAS+ grid and generate the compact 1 mm top-three index. Runtime queries use the nearest voxel, retain original integer percentages, and never renormalize the returned regions.

## Release gate

- Every target NIfTI has the expected 182×218×182 grid, 1 mm voxel size and target affine.
- Cedalion vertex-MNI residuals, voxel-to-vertex matrix dimensions, coverage, and index integrity pass recorded tolerances.
- The identity, authoritative, or estimated mapping decision is recorded with provenance and numerical evidence.
- Brain-mask Dice is at least 0.95 when a non-identity template mapping is required.
- 95th-percentile mapped surface distance is at most 3 mm when a non-identity mapping is required.
- Forward/inverse transform round-trip error is at most 0.5 mm when a transform is used.
- Canonical meshes are manifold where required, contain finite coordinates, use outward scalp normals, and pass deterministic ray-intersection fixtures.
- Harvard–Oxford golden coordinate queries reproduce the recorded top-three English labels and probabilities.
- Each atlas has the expected number of non-empty channels and a maximum probability of exactly 100%; empty or double-scaled upstream files fail closed.
- Every generated file is included in `manifest.json` with its SHA-256.

The atlas gate and full template gate are independent. Passing the atlas gate authorizes atlas-derived region values, but only a pipeline-produced manifest and a correspondence-backed mesh implementation may set full-template `verified=true`. For Cedalion 26.5.1, the pinned archive passes: the official 25,000-vertex MNI correspondence has a 95th-percentile residual of 0.000689 mm, the TemplateFlow target is an exact integer subgrid at Cedalion voxel offset `[5, 6, 76]`, and brain-mask Dice is 0.953731. The accepted mapping is therefore identity; no SyN transform is generated.

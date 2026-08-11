# Third-party scientific assets

CortexLume application source code is MIT licensed. Scientific template and atlas assets remain under their respective upstream licenses and are distributed as separate aggregated data files.

- TemplateFlow MNI152NLin6Asym: see the license and citations in the upstream template repository.
- Harvard–Oxford cortical and subcortical atlases: CC BY-SA 4.0 according to the FSL standard-space atlas license notice. Adapted/resampled atlas files and their transformation scripts must remain available under compatible terms.
- Cedalion ICBM152 head model v26.5.1: source archive
  `https://doc.ibs.tu-berlin.de/cedalion/datasets/26.5.1/hm_icbm152.zip`, SHA-256
  `91bb99709b6ceadd41674acc0db6cf26d70dccb57e41797b474aa9ce6aeed3e8`.
  CortexLume derives browser-ready scalp, pial gray-matter, white-matter, and
  73-landmark visualization assets from this archive, and redistributes the
  official vertex-MNI table and voxel-to-vertex sparse mapping alongside its
  unsimplified canonical projection mesh. Dataset provenance and required
  citations remain those documented by Cedalion (including ICBM152,
  FreeSurfer, and the upstream parcellation resources); Cedalion application
  code itself is MIT licensed.

CortexLume distributes the FSL 5.0 Harvard–Oxford lateralized cortical and
subcortical 1 mm probability volumes, their FSL XML labels, and a derived compact
top-three lookup index. The derivative is an axis-reordered, non-interpolated
representation in TemplateFlow MNI152NLin6Asym RAS+ coordinates. Atlas values
remain unchanged integer percentages and are not renormalized by CortexLume.

BrainNet Viewer is an external GPL-licensed MATLAB application and is not
bundled with CortexLume. The BrainNet export generates interoperable CSV,
`.node`, `.edge`, and MATLAB script files, then calls the user's independently
installed `BrainNet_MapCfg` entry point. Users should cite Xia, Wang, and He
(2013), *BrainNet Viewer: A Network Visualization Tool for Human Brain
Connectomics*, PLOS ONE 8:e68910 when publishing BrainNet Viewer figures.

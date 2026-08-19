# Quick Target data pipeline

Quick Target is an offline functional-target layer. It exposes positive,
FDR-corrected Neurosynth association-test z values on CortexLume's locked
Cedalion ICBM152 25,000-vertex scientific surface. The values are statistics,
not activation probabilities.

## Pinned authorities

- Neurosynth data release 0.7, official `neurosynth/neurosynth-data` repository,
  commit `209c33cd009d0b069398a802198b41b9c488b9b7`.
- NiMARE `0.20.0`, tag commit
  `a3f4ae6d1a799a643fe59c170195d94f0e37506a`.
- Cedalion ICBM152 `26.5.1`, using the checked
  `brain_vertex_coordinates.csv` vertex ordering and its `mni152_r/a/s`
  correspondence.
- CortexLume target space `MNI152NLin6Asym`, whose identity correspondence to
  the Cedalion coordinates is already science-gated in the template manifest.

The generator reads the official GitHub data files. It does not download or
scrape maps from neurosynth.org.

## Statistical definition

For each abstract-derived term, studies with TF-IDF greater than `0.001` form
the selected set and all other studies form the reference set. NiMARE
`MKDAChi2(kernel__r=10, prior=None)` generates the association analysis, followed
by independent Benjamini-Hochberg FDR correction at alpha `0.05`. Only finite,
strictly positive association z values whose FDR-corrected p value is at most
`0.05` are retained.

The corrected support mask is sampled nearest-neighbour and its z magnitude is
sampled trilinearly at every official Cedalion MNI vertex coordinate. This
keeps displayed interpolation inside the FDR-significant voxel support. No
nonlinear registration or nearest-mesh reprojection is introduced. Each map stores strictly increasing `uint16` vertex indices and
positive `float16` z values. Per-map hashes, source-file hashes, float16 error,
grid coverage, parameters, and software versions are recorded in the pack
manifest.

## Curated release profile

The default catalog is defined by the versioned
`config/quick-targets/default-v1.json` profile. Its 133 exact Neurosynth
vocabulary candidates cover eight fNIRS planning domains and carry stable
subdomains and curated search aliases. A profile entry is still gated by at
least 20 selected studies and a real, nonempty positive FDR-corrected surface
map; the generator never fabricates or copies a map between terms.

The bundled v1 release contains 132 usable maps. `awareness` remains in the
profile lineage but is excluded from the pack because its 290 selected studies
produce no positive FDR-corrected support on the locked cortical surface. See
`docs/quick-target-qc-v1.md` for domain counts and review warnings.

Clone the pinned data repository without changing its revision, then install
the build-only dependencies:

```powershell
git clone https://github.com/neurosynth/neurosynth-data.git .tmp/neurosynth-data
git -C .tmp/neurosynth-data checkout 209c33cd009d0b069398a802198b41b9c488b9b7
python -m pip install -e "services/science[quick-target-build]"
```

Build the curated release:

```powershell
python scripts/build_quick_target_pack.py `
  --neurosynth-dir .tmp/neurosynth-data `
  --profile config/quick-targets/default-v1.json `
  --pack-id cortexlume-fnirs-curated-v1 `
  --output assets/templates/MNI152NLin6Asym/generated/quick_targets
```

Generation can be resumed with deterministic `--profile-shard INDEX/COUNT`
packs. Pass completed directories back with repeatable `--reuse-pack`; reuse is
accepted only after checking pack hashes, source hashes and commit, statistical
parameters, target space, and Cedalion correspondence. A final unsharded build
from all shards restores canonical profile ordering.

Omit both `--profile` and `--term` to retain the complete 3,228-term build
capability. Full-vocabulary builds skip terms below 20 selected studies;
explicit profiles fail closed on missing or underpowered terms. The final pack
must be rebuilt twice and produce the
same `catalog.json`, `maps.npz`, and `manifest.json` SHA-256 hashes before
release.

The manifest records domain counts, maps with unusually small surface support,
and every map pair with Pearson `r >= 0.95` across the full 25,000 vertices.
Correlation warnings require semantic review: obvious duplicates are removed,
while distinct constructs may be retained only with a recorded rationale.

NiMARE's conversion of the complete v0.7 database has an observed peak working
set of approximately 4.3 GB per process on Windows. Run one generator process at
a time and budget at least 8 GB of free RAM; the script deliberately performs no
term-level process parallelism.

## Test fixture

`services/science/tests/fixtures/quick_targets` is a deterministic synthetic
three-field pack for API, integrity, and UI integration tests. Its manifest says
`distributionRole: test-fixture`, every map says `fixtureOnly: true`, and its
descriptions explicitly say that it is not a Neurosynth result. It must not be
copied into release assets.

Regenerate it with:

```powershell
python scripts/build_quick_target_pack.py --fixture `
  --pack-id cortexlume-quick-target-test-fixture-v1 `
  --output services/science/tests/fixtures/quick_targets
```

## Runtime contract

- `GET /v1/targets?q=<query>&limit=<1..100>` returns catalog summaries and pack
  provenance.
- `GET /v1/targets/{id}` returns sparse vertex indices, positive z values, and
  map-specific provenance.

The runtime reader validates format, space, surface size, file hashes, sparse
offsets, unique sorted indices, and finite positive values before serving data.
It depends only on NumPy.

Neurosynth data are available under ODbL 1.0. A distributed release-derived
pack must remain separately attributed and satisfy ODbL database obligations;
CortexLume source code remains under its existing license.

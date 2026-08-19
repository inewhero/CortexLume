# Anatomical coverage mosaic

`POST /v1/coverage/anatomical` maps the channels of every loaded patch onto
the locked Cedalion ICBM152 25k cortical surface and partitions the covered
vertices with the locked Harvard-Oxford cortical atlas. The output supports a
single-mesh mosaic and individual region selection in 3D Align.

## Meaning

This is a geometric anatomical coverage prior for visual placement review. It
is not photon sensitivity, fluence, a Jacobian, or a measurement probability.
The Harvard-Oxford values retain their original probabilistic-atlas meaning;
the geometric channel kernel does not acquire that meaning by multiplication.

For channel polyline `c` and surface vertex `v`, CortexLume computes the
Euclidean distance to the closest polyline segment and applies a truncated
Gaussian:

```text
g_c(v) = exp(-d(v,c)^2 / (2 sigma^2))  when d(v,c) <= radius
         0                              otherwise
```

Defaults are `sigma = 12 mm` and `radius = 24 mm`. They define a practical,
bounded review footprint around the existing quadratic channel path; they are
not optical tissue parameters. Multiple channels are combined with
`G(v) = max_c g_c(v)`, which prevents dense or overlapping arrays from
artificially increasing the displayed footprint.

At each covered vertex, the mosaic selects the Harvard-Oxford label with the
largest retained membership at or above the default 5% threshold. The atlas
is sampled by nearest voxel from the reviewed top-three 1 mm index without
renormalization. Region summaries use

```text
M_r = sum_v G(v) * A_r(v)
coveredAtlasMassFraction_r = M_r / sum_k M_k
```

where `A_r(v)` is the original Harvard-Oxford membership. This fraction is a
share of the coverage-weighted atlas mass in this analysis, not an anatomical
or photon probability. The summary is vertex-sampled on the official 25k
surface and does not claim physical surface-area integration.

## Contract

The response is `AnatomicalCoverageAnalysis`. Its sparse `mosaic` arrays are
parallel and ordered by `vertexIndices`:

- `coverageWeights`: `G(v)` in `[0, 1]`;
- `opacityWeights`: `G(v) * A_selected(v)` in `[0, 1]`;
- `regionIndices`: an index into `regions`;
- `atlasMemberships`: original membership of the selected atlas region;
- `dominantChannelIndices`: an index into the stable, sorted `channels` list.

A renderer expands these arrays once onto `brain_scientific.glb` and changes
visibility, color, or opacity on that one mesh. It must not create coincident
meshes per region. `regions[].colorHex` is a stable categorical display hint
with no scientific meaning; `opacityWeights` is the canonical visual alpha
input. Region selection is a mask on `regionIndices`.

Multi-patch channel identity is stable as `instanceId:pairId`, and input
channel order cannot change the result. Empty geometric coverage and coverage
without atlas support return empty mosaic arrays with explicit QC flags and
finite zero-valued metrics.

## Integrity gates

Runtime loading verifies the complete template gate plus the exact assets
used by this analysis:

- `brain_vertex_coordinates.csv`: 25,000 ordered RAS+ MNI vertices;
- `brain_scientific.glb`: the matching unsimplified Cedalion surface;
- `harvard_oxford_top3_1mm.npz`: the reviewed 1 mm cortical atlas index.

The response records their SHA-256 values, the template asset version,
coordinate convention, units, atlas ID, sampling rule, kernel, thresholds,
and aggregation rules.

## Performance gate

The kernel is `O(channels * path segments * 25,000)` and retains one
channel-by-vertex matrix, `O(channels * 25,000)`, for deterministic channel
shares and tie handling. The default 22-channel, 33-point benchmark completed
in approximately 1.26 seconds on the development Windows workstation. The
test suite carries a deliberately generous 8-second ceiling so shared CI hosts
catch algorithmic regressions without treating ordinary scheduler variation
as a failure.

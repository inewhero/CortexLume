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

New requests attach a versioned `sensitivityKernel` to every channel. The
application default is `sd-adaptive-geometric-v2` (the combined recipe). It is
an anisotropic Gaussian centered on the closest local cortical contact of
the projected scalp midpoint. The source–detector scalp chord `d`, local
scalp–cortex gap `h`, and effective scalp depth `D` determine its geometry:

```text
D = min(max(1, configured maximum depth), clamp(d/2, 2, 40))
longitudinalSigma = clamp(0.35*d, 3, 30) * widthScale
lateralSigma = clamp(0.20*d, 2, 20) * widthScale
depthSigma = min(500, 2*max(2, 0.5*sqrt(max(0,D^2-h^2))))
amplitude = exp(-0.5*(h/D)^2)
q = sum_axis (dot(v-center, axis)/sigma_axis)^2
g_c(v) = amplitude*exp(-q/2) when q <= supportSigma^2, else 0
```

An explicit pair depth override replaces `D`. The historical sigma setting
defines `widthScale = kernelSigmaMm/12`; the support setting defines
`supportSigma = supportRadiusMm/kernelSigmaMm` (application default 48/12 = 4).
Explicit historical settings of 24/12 retain two-sigma support; the service
honors each serialized descriptor. The legacy path-only API keeps its original
settings defaults. A two-sigma setting alone does not restore the v1 width
formulas: explicitly select model `sd-adaptive-geometric-v1` to reproduce them.
Version 1 divides lateral sigma by `sqrt(1+(h/D)^2)` and does not double depth
sigma. Existing v1 descriptors retain their stored dimensions. Axes form an
orthonormal local basis; all dimensions are bounded and finite. Degenerate
source–detector tangents use equal tangential sigmas. When the gap is zero
and supplies no local inward direction, the fallback is isotropic. These
coefficients are a geometric heuristic and are not optical tissue parameters.
Channels sharing a center can therefore have different spatial footprints.
Multiple channels are combined with
`G(v) = max_c g_c(v)`, which prevents dense or overlapping arrays from
artificially increasing the displayed footprint.

For backwards compatibility, requests with no channel descriptors use the
legacy fixed Gaussian of Euclidean distance to the sampled polyline. Mixed
legacy/adaptive requests are rejected. Response `parameters.kernel` and
`distanceMetric` identify which calculation was used; each adaptive channel
echoes its descriptor and a canonical descriptor SHA-256. The full heuristic
and its numerical limits are documented in [adaptive projection kernel](../../docs/adaptive-projection-kernel.md).
`pathSha256` hashes
only the displayed path and must not be used as adaptive-kernel identity.

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

The adaptive kernel is `O(channels * 25,000)`; the legacy kernel is
`O(channels * path segments * 25,000)`. Both stream one channel at a time
and retain `O(25,000)` kernel state plus sparse per-channel atlas totals for
deterministic channel shares and tie handling. The
test suite carries a deliberately generous 8-second ceiling so shared CI hosts
catch algorithmic regressions without treating ordinary scheduler variation
as a failure.

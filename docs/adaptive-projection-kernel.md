# Adaptive geometric channel coverage

CortexLume's `sd-adaptive-geometric-v2` approximation gives each channel an
oriented ellipsoidal coverage kernel. Two channels with the same cortical
projection can have different coverage because their fitted source–detector
separations differ. The centerline remains a representative curved path for
display and atlas sampling; coverage is evaluated from the kernel itself.

This is a geometric placement approximation. Its coefficients are heuristic,
not fitted optical parameters or a validated photon transport solution. The
output is not fluence, a photon sensitivity Jacobian, or a probability of
activation. Atlas memberships retain their separate atlas interpretation.

## Geometry and depth controls

Source–detector separation `s` is the Euclidean chord between fitted or measured
scalp contacts, in millimetres. Optode drawing radii do not contribute to this
distance or to scalp–cortex spacing. The contact midpoint is projected onto the
scalp, then onto the nearest local cortex. The distance between those contacts
is the local gap `g`. The cortex contact defines the kernel center; its direction
from the scalp contact defines the depth axis. The source–detector direction
projected onto the tangent plane defines the longitudinal axis.

Automatic effective depth `d` is `s / 2`, with a nominal 2 mm lower bound and an
upper bound of both 40 mm and the project's automatic depth limit. An explicit
1 mm project limit takes precedence over that nominal lower bound. The existing
`projectionSettings.defaultDepthMm` now supplies this limit (25 mm by default).
It no longer gives every channel the same depth. An instance's explicit
`pairDepthOverridesMm` value supplies the channel's absolute depth instead;
the kernel preserves overrides down to 1 mm. The inspector's **USE AUTO DEPTH** action
removes that override.

If `d < g`, the representative path target stays at the local cortex contact.
The kernel records the smaller effective depth and attenuates coverage. It
does not redirect the projection toward the coordinate origin or a remote
cortical intersection.

## Version 1 kernel

Version 1 remains available for historical replay. The original defaults were
sigma 12 mm and support 24 mm (2 normalized sigma).

Let `b = kernelSigmaMm / 12`. For nondegenerate tangent geometry, the kernel
uses these scales in millimetres:

| Quantity | Definition |
| --- | --- |
| Longitudinal sigma | `clamp(0.35 s, 3, 30) b` |
| Lateral sigma | `clamp(0.20 s, 2, 20) b / sqrt(1 + (g / d)^2)` |
| Depth sigma | `max(2, 0.5 sqrt(max(0, d^2 - g^2)))` |
| Amplitude | `exp(-0.5 (g / d)^2)` |
| Normalized support cutoff | `supportRadiusMm / kernelSigmaMm` |

Tangential sigmas have additional numerical bounds of `1e-6`–100 mm, and the
support cutoff is bounded to 0.05–80 sigma. For coincident contacts or a
vanishing tangent direction, longitudinal and lateral sigmas are equal so the
arbitrary tangent basis does not create a preferred tangential direction.
If the scalp and cortex contacts coincide, no anatomical depth normal is
defined. The fallback makes all three sigmas equal (at least 2 mm), so the
weight remains independent of the arbitrary basis and coordinate orientation.

For a vertex's displacement from the center, divide its components along the
three axes by their sigmas. If the sum of their squares is `q`, the weight is
`amplitude * exp(-q / 2)` inside the normalized support cutoff, and zero outside.
Combining channels takes the maximum of their weights. Weights are kept on
their absolute scale; larger gaps are not renormalized back to unit strength.

The displayed coverage uses these absolute weights as opacity. Region
summaries combine them with atlas memberships. **CENTERLINE REGIONS** in the
channel inspector still describes atlas samples along the representative
path, rather than the full ellipsoid.

## Interchange and reproducibility

Renderer coverage requests, the planning engine, and headless MCP requests
share the TypeScript geometry implementation. The scientific service evaluates
the serialized kernel with the same normalized-distance rule. Requests and
analysis channel records contain the descriptor, including its model version,
scales, gap, depth, axes, support and amplitude. A kernel hash is recorded
separately from the centerline path hash; cache keys include the descriptor.

Older external requests containing only a path continue to use the fixed-width
truncated Gaussian model. A single request cannot mix legacy and adaptive
channels. Regenerate projection and coverage results when opening or exporting
projects computed with the earlier model.

Acceptance tests cover different separations at the same center, gap
attenuation, depth limits and overrides, near-coincident contacts, reversal,
rotation and translation, drawing-radius independence, and a shared analytical
fixture exercised by both the TypeScript and Python evaluators. These verify
the approximation's implementation; they do not establish optical validity.

## Version 2 default

The default uses the tested combined recipe: 4-sigma
support at sigma 12 mm/support 48 mm, removal of gap-dependent lateral
contraction, and twice the historical depth sigma (bounded to 500 mm). The
center, axes, longitudinal scale, effective depth and amplitude are preserved.
No-normal and degenerate-tangent fallbacks remain rotationally invariant.
The descriptor carries `sd-adaptive-geometric-v2`, and explicit factory
`model: 'sd-adaptive-geometric-v1'` retains the historical formula and defaults.
Explicit width/support settings are still honored.

This decision prioritizes overall shape agreement with the current optical
reference. It is not fitted optical calibration or evidence of twice the
physical penetration depth. Individual channels can regress despite better aggregate agreement.
Independent anatomies are needed to establish generalization.

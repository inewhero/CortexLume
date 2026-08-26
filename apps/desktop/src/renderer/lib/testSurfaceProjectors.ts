import type { Vec3 } from '@cortexlume/contracts';
import {
  CORTEX_RADII,
  SCALP_RADII,
  add3,
  ellipsoidNormal,
  projectToEllipsoid,
  registerSurfaceProjectors,
  scale3,
} from './geometry';

/** Deterministic test double. Production code must register the real HeadModel projectors. */
export function registerVerifiedTestSurfaceProjectors(): void {
  registerSurfaceProjectors({
    verified: true,
    source: 'verified test mesh projector double',
    scalp: (point) => projectToEllipsoid(point, SCALP_RADII),
    scalpSphereCenter: (point, radiusMm) => {
      const contact = projectToEllipsoid(point, SCALP_RADII);
      return add3(contact, scale3(ellipsoidNormal(contact), radiusMm));
    },
    cortex: (point, radiusMm) => {
      const contact = projectToEllipsoid(point, CORTEX_RADII);
      return radiusMm > 0
        ? add3(contact, scale3(ellipsoidNormal(contact, CORTEX_RADII), radiusMm))
        : contact;
    },
    scalpOffset: (anchor, _rotationRad, uvMm) => projectToEllipsoid(
      add3(anchor, [uvMm[0], uvMm[1], 0] as Vec3),
      SCALP_RADII,
    ),
  });
}

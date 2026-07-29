import type { Vec2 } from '@cortexlume/contracts';

export const FINE_GRID_MM = 10;
export const COARSE_GRID_MM = 30;

export function snapUvToGrid([u, v]: Vec2, spacingMm = FINE_GRID_MM): Vec2 {
  return [
    Math.round(u / spacingMm) * spacingMm,
    Math.round(v / spacingMm) * spacingMm,
  ];
}

export function screenFromUv(
  [u, v]: Vec2,
  width: number,
  height: number,
  scale: number,
): Vec2 {
  return [width / 2 + u * scale, height / 2 - v * scale];
}

export function uvFromScreen(
  [x, y]: Vec2,
  width: number,
  height: number,
  scale: number,
): Vec2 {
  return snapUvToGrid([
    (x - width / 2) / scale,
    (height / 2 - y) / scale,
  ]);
}

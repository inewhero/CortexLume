from __future__ import annotations

from collections.abc import Iterable
from math import cos, hypot, sin, sqrt
from statistics import fmean

from .models import LayoutDefinition, LayoutInstance, Vec2, Vec3

SCALP_RADII: Vec3 = (86.0, 105.0, 100.0)
CORTEX_RADII: Vec3 = (72.0, 88.0, 82.0)


def add(a: Vec3, b: Vec3) -> Vec3:
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def subtract(a: Vec3, b: Vec3) -> Vec3:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def scale(value: Vec3, factor: float) -> Vec3:
    return (value[0] * factor, value[1] * factor, value[2] * factor)


def dot(a: Vec3, b: Vec3) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def cross(a: Vec3, b: Vec3) -> Vec3:
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def normalize(value: Vec3) -> Vec3:
    length = hypot(*value)
    return (0.0, 0.0, 1.0) if length == 0 else scale(value, 1.0 / length)


def project_to_ellipsoid(point: Vec3, radii: Vec3 = SCALP_RADII) -> Vec3:
    denominator = sqrt(sum((point[index] / radii[index]) ** 2 for index in range(3)))
    return (0.0, 0.0, radii[2]) if denominator == 0 else scale(point, 1.0 / denominator)


def ellipsoid_normal(point: Vec3, radii: Vec3 = SCALP_RADII) -> Vec3:
    return normalize(tuple(point[index] / (radii[index] ** 2) for index in range(3)))  # type: ignore[arg-type]


def tangent_basis(anchor: Vec3, rotation_rad: float) -> tuple[Vec3, Vec3, Vec3]:
    normal = ellipsoid_normal(anchor)
    anterior: Vec3 = (0.0, 1.0, 0.0)
    superior: Vec3 = (0.0, 0.0, 1.0)
    v = normalize(add(anterior, scale(normal, -dot(anterior, normal))))
    if abs(dot(v, normal)) > 0.99:
        v = normalize(add(superior, scale(normal, -dot(superior, normal))))
    u = normalize(cross(v, normal))
    cosine, sine = cos(rotation_rad), sin(rotation_rad)
    rotated_u = normalize(add(scale(u, cosine), scale(v, sine)))
    rotated_v = normalize(add(scale(v, cosine), scale(u, -sine)))
    return rotated_u, rotated_v, normal


def effective_uv(layout: LayoutDefinition, instance: LayoutInstance, optode_id) -> Vec2:
    for override in instance.overrides:
        if override.optode_id == optode_id:
            return override.uv_mm
    for optode in layout.optodes:
        if optode.id == optode_id:
            return optode.uv_mm
    return (0.0, 0.0)


def fitted_positions(layout: LayoutDefinition, instance: LayoutInstance) -> dict:
    anchor = project_to_ellipsoid(instance.anchor_ras_mm)
    u_axis, v_axis, _ = tangent_basis(anchor, instance.rotation_rad + instance.mapping_rotation_rad)
    result = {}
    for optode in layout.optodes:
        u_mm, v_mm = effective_uv(layout, instance, optode.id)
        tangent_point = add(anchor, add(scale(u_axis, u_mm), scale(v_axis, v_mm)))
        result[optode.id] = project_to_ellipsoid(tangent_point)
    return result


def cortex_projection(scalp_point: Vec3) -> Vec3:
    return project_to_ellipsoid(normalize(scalp_point), CORTEX_RADII)


def inward_depth_target(cortex_point: Vec3, depth_mm: float) -> Vec3:
    return add(cortex_point, scale(normalize(cortex_point), -depth_mm))


def pair_midpoint(source: Vec3, detector: Vec3) -> Vec3:
    return project_to_ellipsoid(scale(add(source, detector), 0.5))


def distance(a: Vec3, b: Vec3) -> float:
    delta = subtract(a, b)
    return hypot(*delta)


def fit_errors(layout: LayoutDefinition, positions: dict) -> tuple[float, float]:
    errors = []
    for pair in layout.pairs:
        source = positions.get(pair.source_id)
        detector = positions.get(pair.detector_id)
        if source is None or detector is None:
            continue
        errors.append(abs(distance(source, detector) - pair.nominal_distance_mm))
    return (fmean(errors), max(errors)) if errors else (0.0, 0.0)


def all_points_on_ellipsoid(points: Iterable[Vec3], radii: Vec3 = SCALP_RADII, tolerance: float = 1e-6) -> bool:
    for point in points:
        equation = sum((point[index] / radii[index]) ** 2 for index in range(3))
        if abs(equation - 1.0) > tolerance:
            return False
    return True

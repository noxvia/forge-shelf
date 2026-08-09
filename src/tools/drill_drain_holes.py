#!/usr/bin/env python3
"""Drill drain holes through the underside of a mesh.

Resin needs a path out of a hollowed model. PrusaSlicer can only place drain
holes through its GUI, so they are cut here, before slicing, as boolean
subtractions of vertical cylinders.

Two things make this actually work, both learned the hard way:

  * Holes must land on real material. A naive ring of points around the centre
    misses entirely on anything that isn't a solid block, so candidates are
    ray-tested against the mesh and only surviving ones are used.

  * PrusaSlicer must be told --hollowing-closing-distance 0. Its default of 2mm
    closes small openings back up during hollowing, which seals the drilled hole
    and leaves the resin trapped anyway. The caller is responsible for that flag;
    this script only cuts geometry.

Usage: drill_drain_holes.py <input> <output> <count> <diameter_mm>
Prints a JSON summary on stdout.
"""
import json
import sys

import numpy as np
import trimesh


def candidate_points(mesh: trimesh.Trimesh, samples: int = 400) -> np.ndarray:
    """Footprint points where a vertical ray actually passes through material."""
    lo, hi = mesh.bounds
    # A jittered grid covers the footprint more evenly than random sampling.
    side = int(np.ceil(np.sqrt(samples)))
    xs = np.linspace(lo[0], hi[0], side + 2)[1:-1]
    ys = np.linspace(lo[1], hi[1], side + 2)[1:-1]
    grid = np.array([[x, y] for x in xs for y in ys])

    origins = np.column_stack([grid, np.full(len(grid), lo[2] - 1.0)])
    directions = np.tile([0.0, 0.0, 1.0], (len(grid), 1))

    hit = mesh.ray.intersects_any(ray_origins=origins, ray_directions=directions)
    return grid[hit]


def spread(points: np.ndarray, count: int) -> np.ndarray:
    """Farthest-point sampling, so holes end up spread rather than clustered."""
    if len(points) <= count:
        return points
    chosen = [int(np.argmin(np.linalg.norm(points - points.mean(axis=0), axis=1)))]
    for _ in range(count - 1):
        d = np.min(
            np.linalg.norm(points[:, None, :] - points[chosen][None, :, :], axis=2), axis=1
        )
        chosen.append(int(np.argmax(d)))
    return points[chosen]


def drill(mesh: trimesh.Trimesh, count: int, diameter: float):
    lo, hi = mesh.bounds
    height = float(hi[2] - lo[2])
    radius = diameter / 2.0

    valid = candidate_points(mesh)
    if len(valid) == 0:
        raise RuntimeError(
            'no vertical ray through the model hit material — cannot place drain holes'
        )

    # Keep holes clear of the silhouette edge so they cut through a wall rather
    # than grazing it and leaving a sliver.
    centre = valid.mean(axis=0)
    margin = radius * 1.5
    inset = valid[
        (np.abs(valid[:, 0] - centre[0]) < (hi[0] - lo[0]) / 2 - margin)
        & (np.abs(valid[:, 1] - centre[1]) < (hi[1] - lo[1]) / 2 - margin)
    ]
    usable = inset if len(inset) >= count else valid

    spots = spread(usable, count)

    cutters = []
    for (x, y) in spots:
        # Overshoot both ends: a cylinder flush with the surface makes for a
        # fragile boolean.
        c = trimesh.creation.cylinder(radius=radius, height=height * 1.5)
        c.apply_translation([float(x), float(y), float(lo[2] + height * 0.5)])
        cutters.append(c)

    result = trimesh.boolean.difference([mesh] + cutters)
    return result, spots


def main() -> int:
    if len(sys.argv) != 5:
        print(__doc__, file=sys.stderr)
        return 2

    src, dst, count, diameter = sys.argv[1], sys.argv[2], int(sys.argv[3]), float(sys.argv[4])

    mesh = trimesh.load(src, force='mesh')
    before = float(mesh.volume)

    result, spots = drill(mesh, count, diameter)

    if not result.is_watertight:
        # Try to salvage: a non-watertight result slices unpredictably.
        result.fill_holes()

    result.export(dst)

    print(
        json.dumps(
            {
                'ok': True,
                'holes': len(spots),
                'diameterMm': diameter,
                'positions': [[round(float(x), 2), round(float(y), 2)] for x, y in spots],
                'volumeBefore': round(before, 2),
                'volumeAfter': round(float(result.volume), 2),
                'watertight': bool(result.is_watertight),
                'faces': int(len(result.faces)),
            }
        )
    )
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001 - surfaced to the caller as JSON
        print(json.dumps({'ok': False, 'error': str(exc)}))
        sys.exit(1)

#!/usr/bin/env python3
"""Bake a build plate into a single mesh ready for slicing.

PrusaSlicer's CLI transform flags (--rotate, --scale, --center) apply to
everything it loads, not per object, so an arrangement made in the browser has
to be applied to the geometry here before the slicer ever sees it.

Transform order matches how the viewer composes it, and has to: scale, then
rotate about X, Y, Z, then drop the object onto the plate, then translate to its
XY position. Getting this order wrong produces a plate that looks right on
screen and slices wrong.

Input is a JSON spec on argv[1]:

  {
    "output": "/path/plate.stl",
    "plate": {"x": 218.88, "y": 122.88, "z": 220.0},   optional, for fit check
    "items": [
      {"path": "/data/models/../a.stl", "posX": 20, "posY": 20, "posZ": 0,
       "rotX": 0, "rotY": 0, "rotZ": 30, "scale": 1.5}
    ]
  }

Prints a JSON summary on stdout.
"""
import json
import sys

import numpy as np
import trimesh


def place(mesh: trimesh.Trimesh, item: dict) -> trimesh.Trimesh:
    m = mesh.copy()

    scale = float(item.get('scale', 1) or 1)
    if scale != 1:
        m.apply_scale(scale)

    for axis, key in ((( 1, 0, 0), 'rotX'), ((0, 1, 0), 'rotY'), ((0, 0, 1), 'rotZ')):
        deg = float(item.get(key, 0) or 0)
        if deg:
            m.apply_transform(trimesh.transformations.rotation_matrix(np.radians(deg), axis))

    # Normalise the origin so posX/posY mean "where the object's centre sits on
    # the plate" and posZ is a deliberate lift. Without this the position would
    # depend on wherever the exporter happened to put the mesh's origin, and the
    # browser and this script would disagree about what a coordinate means.
    lo, hi = m.bounds
    m.apply_translation([
        -float((lo[0] + hi[0]) / 2),
        -float((lo[1] + hi[1]) / 2),
        -float(lo[2]),
    ])

    m.apply_translation([
        float(item.get('posX', 0) or 0),
        float(item.get('posY', 0) or 0),
        float(item.get('posZ', 0) or 0),
    ])
    return m


def main() -> int:
    spec = json.load(open(sys.argv[1]))
    items = spec.get('items') or []
    if not items:
        raise RuntimeError('plate has no items')

    parts = []
    placed = []
    for item in items:
        mesh = trimesh.load(item['path'], force='mesh')
        m = place(mesh, item)
        parts.append(m)
        lo, hi = m.bounds
        placed.append({
            'path': item['path'],
            'min': [round(float(v), 2) for v in lo],
            'max': [round(float(v), 2) for v in hi],
        })

    combined = trimesh.util.concatenate(parts)
    combined.export(spec['output'])

    lo, hi = combined.bounds
    size = hi - lo

    result = {
        'ok': True,
        'items': len(parts),
        'faces': int(len(combined.faces)),
        'watertight': bool(combined.is_watertight),
        'boundsMin': [round(float(v), 2) for v in lo],
        'boundsMax': [round(float(v), 2) for v in hi],
        'sizeMm': [round(float(v), 2) for v in size],
        'placed': placed,
    }

    plate = spec.get('plate')
    if plate:
        # Report which way it doesn't fit; "too big" alone is not actionable.
        over = {
            'x': bool(size[0] > float(plate['x']) + 1e-6),
            'y': bool(size[1] > float(plate['y']) + 1e-6),
            'z': bool(hi[2] > float(plate['z']) + 1e-6),
        }
        result['fits'] = not any(over.values())
        result['exceeds'] = [axis for axis, bad in over.items() if bad]

    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001 - reported as JSON to the caller
        print(json.dumps({'ok': False, 'error': str(exc)}))
        sys.exit(1)

"""Build-time proof that plate export works, exercised end to end.

Runs the real bake script and reads the result back with trimesh's reader, which
is independent of our 3MF writer. Checking that the file merely exists would not
have caught the writer trimesh ships, which emits build items referencing object
ids it never defines.
"""
import json
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import trimesh  # noqa: E402


def main() -> int:
    work = tempfile.mkdtemp()
    src = os.path.join(work, 'cube.stl')
    trimesh.creation.box(extents=[10, 10, 10]).export(src)

    out = os.path.join(work, 'plate.3mf')
    spec = {
        'output': out,
        'format': '3mf',
        'items': [
            {
                'path': src, 'name': f'cube_{i}',
                'posX': x, 'posY': 0, 'posZ': 0,
                'rotX': 0, 'rotY': 0, 'rotZ': 0, 'scale': 1,
            }
            for i, x in enumerate((0, 20, 40))
        ],
    }
    spec_path = os.path.join(work, 'spec.json')
    with open(spec_path, 'w') as fh:
        json.dump(spec, fh)

    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'bake_plate.py')
    proc = subprocess.run([sys.executable, script, spec_path], capture_output=True, text=True)
    if proc.returncode != 0:
        print(proc.stdout, proc.stderr, file=sys.stderr)
        return 1

    result = json.loads(proc.stdout.strip().splitlines()[-1])
    if not result.get('ok'):
        print('bake failed:', result, file=sys.stderr)
        return 1

    scene = trimesh.load(out)
    count = len(getattr(scene, 'geometry', {}))
    if count != 3:
        print(f'expected 3 separate objects in the 3MF, read back {count}', file=sys.stderr)
        return 1

    print('    meshtools   ok (3mf export verified, 3 objects preserved)')
    return 0


if __name__ == '__main__':
    sys.exit(main())

"""Minimal, correct 3MF writer.

trimesh has a 3MF exporter but it emits build items referencing object ids it
never defines — its own reader rejects the result with "id N included but not
defined!" and the file opens empty in a slicer. Rather than ship that, this
writes the format directly. 3MF is an OPC zip holding one XML part, and the
core spec for meshes is small enough to implement exactly.

Each object's transform is baked into its vertices and emitted as its own
<object>, with an identity build item. That keeps the objects separate in the
slicer while sidestepping transform-matrix conventions entirely.
"""
import zipfile
from typing import Iterable, Sequence

CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>
"""

RELS = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
"""


def _fmt(value: float) -> str:
    """Trim float noise; 3MF is millimetres and micron precision is plenty."""
    return f"{value:.6f}".rstrip('0').rstrip('.') or '0'


def write_3mf(path: str, objects: Iterable[tuple[str, Sequence, Sequence]], unit: str = 'millimeter') -> dict:
    """objects: iterable of (name, vertices Nx3, faces Mx3) with transforms baked in."""
    parts = []
    total_v = 0
    total_t = 0

    for index, (name, vertices, faces) in enumerate(objects, start=1):
        rows = []
        rows.append(f'  <object id="{index}" type="model" name="{_escape(name)}">')
        rows.append('   <mesh>')
        rows.append('    <vertices>')
        for v in vertices:
            rows.append(f'     <vertex x="{_fmt(v[0])}" y="{_fmt(v[1])}" z="{_fmt(v[2])}"/>')
        rows.append('    </vertices>')
        rows.append('    <triangles>')
        for f in faces:
            rows.append(f'     <triangle v1="{int(f[0])}" v2="{int(f[1])}" v3="{int(f[2])}"/>')
        rows.append('    </triangles>')
        rows.append('   </mesh>')
        rows.append('  </object>')
        parts.append('\n'.join(rows))
        total_v += len(vertices)
        total_t += len(faces)

    # Build items reference exactly the ids defined above — the thing trimesh
    # gets wrong.
    items = '\n'.join(f'  <item objectid="{i}"/>' for i in range(1, len(parts) + 1))

    model = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<model unit="{unit}" xml:lang="en-US" '
        'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n'
        ' <metadata name="Application">ForgeShelf</metadata>\n'
        ' <resources>\n'
        + '\n'.join(parts) + '\n'
        ' </resources>\n'
        ' <build>\n'
        + items + '\n'
        ' </build>\n'
        '</model>\n'
    )

    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', CONTENT_TYPES)
        z.writestr('_rels/.rels', RELS)
        z.writestr('3D/3dmodel.model', model)

    return {'objects': len(parts), 'vertices': total_v, 'triangles': total_t}


def _escape(text: str) -> str:
    return (
        str(text)
        .replace('&', '&amp;')
        .replace('<', '&lt;')
        .replace('>', '&gt;')
        .replace('"', '&quot;')
    )

import path from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';

/**
 * Mesh statistics computed server-side at upload time, so the library can show
 * size and volume without the browser having to open every file.
 *
 * Volume uses the signed-tetrahedron sum, which is exact for a closed mesh and
 * meaningless-but-harmless for an open one. Units are whatever the file uses;
 * STL and 3MF are millimetres by convention (3MF may declare otherwise and we
 * honour its unit attribute).
 */
export interface MeshStats {
  triangles: number;
  bbox: { x: number; y: number; z: number };
  volumeMm3: number;
  /** True when the signed volume came out negative, i.e. inverted normals. */
  invertedNormals: boolean;
}

const EMPTY: MeshStats = {
  triangles: 0,
  bbox: { x: 0, y: 0, z: 0 },
  volumeMm3: 0,
  invertedNormals: false,
};

class Accumulator {
  triangles = 0;
  minX = Infinity;
  minY = Infinity;
  minZ = Infinity;
  maxX = -Infinity;
  maxY = -Infinity;
  maxZ = -Infinity;
  signedVolume = 0;

  vertex(x: number, y: number, z: number) {
    if (x < this.minX) this.minX = x;
    if (y < this.minY) this.minY = y;
    if (z < this.minZ) this.minZ = z;
    if (x > this.maxX) this.maxX = x;
    if (y > this.maxY) this.maxY = y;
    if (z > this.maxZ) this.maxZ = z;
  }

  triangle(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
  ) {
    this.triangles++;
    this.vertex(ax, ay, az);
    this.vertex(bx, by, bz);
    this.vertex(cx, cy, cz);
    // (a · (b × c)) / 6
    this.signedVolume +=
      (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }

  finish(scale = 1): MeshStats {
    if (this.triangles === 0) return EMPTY;
    const s = scale;
    return {
      triangles: this.triangles,
      bbox: {
        x: round((this.maxX - this.minX) * s),
        y: round((this.maxY - this.minY) * s),
        z: round((this.maxZ - this.minZ) * s),
      },
      volumeMm3: round(Math.abs(this.signedVolume) * s ** 3),
      invertedNormals: this.signedVolume < 0,
    };
  }
}

const round = (n: number) => Math.round(n * 1000) / 1000;

// ---------------------------------------------------------------------------
// STL
// ---------------------------------------------------------------------------

function isBinaryStl(buf: Buffer): boolean {
  if (buf.length < 84) return false;
  // A binary STL declares its triangle count at offset 80; if that matches the
  // file length exactly, trust it regardless of what the header says.
  const count = buf.readUInt32LE(80);
  if (84 + count * 50 === buf.length) return true;
  // Otherwise fall back to sniffing for the ASCII keyword.
  const head = buf.subarray(0, 512).toString('latin1').trimStart().toLowerCase();
  return !head.startsWith('solid');
}

function parseBinaryStl(buf: Buffer): MeshStats {
  const acc = new Accumulator();
  const count = buf.readUInt32LE(80);
  const expected = 84 + count * 50;
  // Tolerate trailing junk, but never read past the buffer.
  const usable = Math.min(count, Math.floor((buf.length - 84) / 50));
  if (expected !== buf.length) {
    // Not fatal — plenty of exporters pad the file.
  }
  for (let i = 0; i < usable; i++) {
    const o = 84 + i * 50 + 12; // skip the per-facet normal
    acc.triangle(
      buf.readFloatLE(o), buf.readFloatLE(o + 4), buf.readFloatLE(o + 8),
      buf.readFloatLE(o + 12), buf.readFloatLE(o + 16), buf.readFloatLE(o + 20),
      buf.readFloatLE(o + 24), buf.readFloatLE(o + 28), buf.readFloatLE(o + 32),
    );
  }
  return acc.finish();
}

function parseAsciiStl(buf: Buffer): MeshStats {
  const acc = new Accumulator();
  const text = buf.toString('latin1');
  const re = /vertex\s+(-?[\d.eE+]+)\s+(-?[\d.eE+]+)\s+(-?[\d.eE+]+)/g;
  const v: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    v.push(Number(m[1]), Number(m[2]), Number(m[3]));
    if (v.length === 9) {
      acc.triangle(v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8]);
      v.length = 0;
    }
  }
  return acc.finish();
}

// ---------------------------------------------------------------------------
// OBJ
// ---------------------------------------------------------------------------

function parseObj(buf: Buffer): MeshStats {
  const acc = new Accumulator();
  const verts: number[] = [];
  const text = buf.toString('utf8');

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('v ')) {
      const p = line.slice(2).trim().split(/\s+/);
      verts.push(Number(p[0]), Number(p[1]), Number(p[2]));
    } else if (line.startsWith('f ')) {
      // Indices may be v, v/vt or v/vt/vn, and may be negative (relative).
      const idx = line
        .slice(2)
        .trim()
        .split(/\s+/)
        .map((tok) => {
          const n = Number.parseInt(tok.split('/')[0], 10);
          return n < 0 ? verts.length / 3 + n : n - 1;
        })
        .filter((n) => Number.isInteger(n) && n >= 0);

      // Fan-triangulate any n-gon.
      for (let i = 1; i + 1 < idx.length; i++) {
        const a = idx[0] * 3;
        const b = idx[i] * 3;
        const c = idx[i + 1] * 3;
        if (verts[c + 2] === undefined) continue;
        acc.triangle(
          verts[a], verts[a + 1], verts[a + 2],
          verts[b], verts[b + 1], verts[b + 2],
          verts[c], verts[c + 1], verts[c + 2],
        );
      }
    }
  }
  return acc.finish();
}

// ---------------------------------------------------------------------------
// 3MF
// ---------------------------------------------------------------------------

const UNIT_TO_MM: Record<string, number> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000,
};

/**
 * A 3MF is an OPC zip; the geometry lives in 3D/3dmodel.model as XML. We read
 * vertices and triangles with a streaming regex rather than a full XML parse —
 * the schema is rigid enough that this is reliable and much faster on the
 * 100 MB+ models people actually download.
 */
function parse3mf(buf: Buffer): MeshStats {
  const files = unzipSync(new Uint8Array(buf), {
    filter: (f) => /3dmodel\.model$/i.test(f.name) || /\.model$/i.test(f.name),
  });

  const entry =
    Object.keys(files).find((k) => /3d\/3dmodel\.model$/i.test(k)) ??
    Object.keys(files).find((k) => /\.model$/i.test(k));
  if (!entry) return EMPTY;

  const xml = strFromU8(files[entry]);

  const unitMatch = /<model[^>]*\bunit="([^"]+)"/i.exec(xml);
  const scale = UNIT_TO_MM[(unitMatch?.[1] ?? 'millimeter').toLowerCase()] ?? 1;

  const acc = new Accumulator();

  // 3MF can hold several <object>s; each has its own vertex index space, so
  // process one <mesh> block at a time.
  const meshRe = /<mesh>([\s\S]*?)<\/mesh>/gi;
  let meshMatch: RegExpExecArray | null;
  while ((meshMatch = meshRe.exec(xml)) !== null) {
    const mesh = meshMatch[1];
    const verts: number[] = [];

    const vRe = /<vertex\s+x="(-?[\d.eE+-]+)"\s+y="(-?[\d.eE+-]+)"\s+z="(-?[\d.eE+-]+)"/gi;
    let vm: RegExpExecArray | null;
    while ((vm = vRe.exec(mesh)) !== null) {
      verts.push(Number(vm[1]), Number(vm[2]), Number(vm[3]));
    }

    const tRe = /<triangle\s+v1="(\d+)"\s+v2="(\d+)"\s+v3="(\d+)"/gi;
    let tm: RegExpExecArray | null;
    while ((tm = tRe.exec(mesh)) !== null) {
      const a = Number(tm[1]) * 3;
      const b = Number(tm[2]) * 3;
      const c = Number(tm[3]) * 3;
      if (verts[c + 2] === undefined) continue;
      acc.triangle(
        verts[a], verts[a + 1], verts[a + 2],
        verts[b], verts[b + 1], verts[b + 2],
        verts[c], verts[c + 1], verts[c + 2],
      );
    }
  }

  return acc.finish(scale);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Best-effort. Formats we can't read (STEP, SCAD, proprietary CAD) return null
 * rather than throwing — the file is still perfectly worth cataloguing.
 */
export function meshStats(filename: string, buf: Buffer): MeshStats | null {
  const lower = filename.toLowerCase();
  const ext = path.extname(lower);
  try {
    if (ext === '.stl') return isBinaryStl(buf) ? parseBinaryStl(buf) : parseAsciiStl(buf);
    if (ext === '.3mf') return parse3mf(buf);
    if (ext === '.obj') return parseObj(buf);
    return null;
  } catch (err) {
    console.warn(`[mesh] could not parse ${filename}:`, err);
    return null;
  }
}

/**
 * Is this .3mf a slicer *project* rather than plain geometry?
 *
 * Both are the same container, so the extension can't tell them apart. A
 * project carries the slicer's own settings alongside the mesh — Bambu and
 * Orca write project_settings.config, PrusaSlicer writes Slic3r_PE.config — and
 * that is what distinguishes "an arrangement I made in a slicer" from "a model
 * someone exported". Getting it wrong only misfiles it, so unreadable archives
 * are treated as plain meshes.
 */
export function is3mfProject(buf: Buffer): boolean {
  const MARKERS = [
    /project_settings\.config$/i, // Bambu Studio, OrcaSlicer
    /model_settings\.config$/i, // Bambu Studio
    /slic3r_pe\.config$/i, // PrusaSlicer
    /slic3r_pe_model\.config$/i,
    /plate_\d+\.json$/i, // per-plate metadata
  ];

  try {
    const files = unzipSync(new Uint8Array(buf), {
      filter: (f) => MARKERS.some((m) => m.test(f.name)),
    });
    return Object.keys(files).length > 0;
  } catch {
    return false;
  }
}

/** Volume in millilitres — the number that matters when budgeting resin. */
export function volumeMl(volumeMm3: number): number {
  return Math.round((volumeMm3 / 1000) * 100) / 100;
}

/** Rough filament length in metres for a 1.75 mm filament at a given infill. */
export function filamentMetres(volumeMm3: number, infill = 0.15, shellFraction = 0.35): number {
  const effective = volumeMm3 * (shellFraction + (1 - shellFraction) * infill);
  const crossSection = Math.PI * (1.75 / 2) ** 2; // mm²
  return Math.round((effective / crossSection / 1000) * 100) / 100;
}

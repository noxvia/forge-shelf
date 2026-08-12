import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { env } from './env';
import { FileKind, Technology } from '@prisma/client';

/**
 * Layout under STORAGE_DIR:
 *
 *   models/<modelId>/<fileId>-<safeName>   uploaded meshes, images, docs
 *   slices/<taskId>/<name>                 slicer output
 *   thumbs/<modelId>.png                   library thumbnails
 *   tmp/                                   in-flight uploads and scratch
 *
 * Every path stored in the database is relative to STORAGE_DIR so the volume can
 * be moved or re-mounted anywhere.
 */

export const SUBDIRS = ['models', 'slices', 'thumbs', 'tmp'] as const;

export async function ensureStorage(): Promise<void> {
  for (const d of SUBDIRS) {
    await fsp.mkdir(path.join(env.storageDir, d), { recursive: true });
  }
}

/** Resolve a stored relative path, refusing anything that escapes STORAGE_DIR. */
export function absPath(relative: string): string {
  const root = path.resolve(env.storageDir);
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Path escapes storage root: ${relative}`);
  }
  return resolved;
}

/** Strip directory components and anything that isn't filename-safe. */
export function safeName(name: string): string {
  const base = path.basename(name.replace(/\\/g, '/'));
  const cleaned = base.replace(/[^A-Za-z0-9._ \-()[\]]+/g, '_').replace(/^\.+/, '');
  return (cleaned || 'file').slice(0, 180);
}

// ---------------------------------------------------------------------------
// File type classification
// ---------------------------------------------------------------------------

const MESH_EXT = ['.stl', '.3mf', '.obj', '.ply', '.step', '.stp', '.scad', '.f3d', '.blend'];
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'];
const DOC_EXT = ['.txt', '.md', '.pdf', '.rtf', '.nfo'];
const ARCHIVE_EXT = ['.zip', '.7z', '.rar', '.tar', '.gz'];

/** Slicer project files — an arrangement plus settings, not raw geometry. */
const PLATE_EXT = ['.lys', '.lyt', '.chitubox', '.ctbproj', '.prusaproject'];

/** Sliced output, mapped to the technology that produced it. */
const SLICED_EXT: Record<string, Technology> = {
  '.gcode': Technology.FDM,
  '.bgcode': Technology.FDM,
  '.gco': Technology.FDM,
  '.g': Technology.FDM,
  '.ctb': Technology.SLA,
  '.cbddlp': Technology.SLA,
  '.goo': Technology.SLA,
  '.sl1': Technology.SLA,
  '.sl1s': Technology.SLA,
  '.pwmx': Technology.SLA,
  '.pwma': Technology.SLA,
  '.pws': Technology.SLA,
  '.photon': Technology.SLA,
  '.pm3': Technology.SLA,
};

/**
 * `.gcode.3mf` is a sliced Bambu/Orca file while a plain `.3mf` is a mesh, so
 * classification has to look at the compound extension first.
 */
export function classify(filename: string): { kind: FileKind; technology: Technology | null } {
  const lower = filename.toLowerCase();
  const ext = path.extname(lower);

  if (lower.endsWith('.gcode.3mf')) return { kind: FileKind.SLICED, technology: Technology.FDM };
  if (ext in SLICED_EXT) return { kind: FileKind.SLICED, technology: SLICED_EXT[ext] };
  if (PLATE_EXT.includes(ext)) return { kind: FileKind.PLATE, technology: null };
  if (MESH_EXT.includes(ext)) return { kind: FileKind.MESH, technology: null };
  if (IMAGE_EXT.includes(ext)) return { kind: FileKind.IMAGE, technology: null };
  if (DOC_EXT.includes(ext)) return { kind: FileKind.DOC, technology: null };
  if (ARCHIVE_EXT.includes(ext)) return { kind: FileKind.ARCHIVE, technology: null };
  return { kind: FileKind.DOC, technology: null };
}

export function mimeFor(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case '.stl':
      return 'model/stl';
    case '.3mf':
      return 'model/3mf';
    case '.obj':
      return 'model/obj';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.pdf':
      return 'application/pdf';
    case '.txt':
    case '.md':
      return 'text/plain; charset=utf-8';
    case '.zip':
      return 'application/zip';
    default:
      return 'application/octet-stream';
  }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface WriteResult {
  relPath: string;
  size: number;
  sha256: string;
}

/**
 * Streams a web ReadableStream (or Buffer) to disk while hashing, so a 500 MB
 * upload never lands in memory. Enforces MAX_UPLOAD_MB as it goes and cleans up
 * the partial file if the limit is hit or the client disconnects.
 */
export async function writeStream(
  relPath: string,
  body: ReadableStream<Uint8Array> | Buffer,
  opts: { maxBytes?: number } = {},
): Promise<WriteResult> {
  const dest = absPath(relPath);
  await fsp.mkdir(path.dirname(dest), { recursive: true });

  const max = opts.maxBytes ?? env.maxUploadBytes;
  const hash = crypto.createHash('sha256');
  let size = 0;

  const source =
    body instanceof Buffer ? Readable.from(body) : Readable.fromWeb(body as never);

  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > max) {
        cb(new Error(`Upload exceeds limit of ${Math.round(max / 1024 / 1024)} MB`));
        return;
      }
      hash.update(chunk);
      this.push(chunk);
      cb();
    },
  });

  try {
    await pipeline(source, counter, fs.createWriteStream(dest));
  } catch (err) {
    await fsp.rm(dest, { force: true });
    throw err;
  }

  return { relPath, size, sha256: hash.digest('hex') };
}

export async function writeBuffer(relPath: string, data: Buffer): Promise<WriteResult> {
  return writeStream(relPath, data, { maxBytes: Number.MAX_SAFE_INTEGER });
}

export function modelFileRelPath(modelId: string, fileId: string, filename: string): string {
  return path.posix.join('models', modelId, `${fileId}-${safeName(filename)}`);
}

export function thumbRelPath(modelId: string): string {
  return path.posix.join('thumbs', `${modelId}.png`);
}

export function sliceDirRelPath(taskId: string): string {
  return path.posix.join('slices', taskId);
}

// ---------------------------------------------------------------------------
// Reading & removal
// ---------------------------------------------------------------------------

export async function statOrNull(relPath: string) {
  try {
    return await fsp.stat(absPath(relPath));
  } catch {
    return null;
  }
}

export async function readFileBuffer(relPath: string): Promise<Buffer> {
  return fsp.readFile(absPath(relPath));
}

export async function removeQuietly(relPath: string | null | undefined): Promise<void> {
  if (!relPath) return;
  try {
    await fsp.rm(absPath(relPath), { force: true, recursive: true });
  } catch (err) {
    console.warn('[storage] could not remove', relPath, err);
  }
}

/** Removes a model's whole directory plus its thumbnail. */
export async function removeModelTree(modelId: string): Promise<void> {
  await removeQuietly(path.posix.join('models', modelId));
  await removeQuietly(thumbRelPath(modelId));
}

export function humanSize(bytes: number | bigint): string {
  const n = Number(bytes);
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

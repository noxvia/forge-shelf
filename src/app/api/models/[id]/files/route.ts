import { z } from 'zod';
import { FileKind } from '@prisma/client';
import { prisma } from '@/lib/db';
import { ok, handler, HttpError } from '@/lib/json';
import {
  classify,
  mimeFor,
  modelFileRelPath,
  writeStream,
  safeName,
  readFileBuffer,
  removeQuietly,
  ensureStorage,
} from '@/lib/storage';
import { meshStats, is3mfProject } from '@/lib/mesh';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Uploads stream straight to disk; never let the framework buffer the body.
export const maxDuration = 3600;

type Ctx = { params: { id: string } };

const query = z.object({
  filename: z.string().trim().min(1).max(255),
  /** Override the automatic classification when the caller knows better. */
  kind: z.nativeEnum(FileKind).optional(),
});

/**
 * PUT /api/models/:id/files?filename=thing.stl
 *
 * Raw body upload — no multipart. The body is piped to disk while being hashed,
 * so memory stays flat regardless of file size, and the client can show real
 * progress with a single fetch per file.
 */
export const PUT = handler(async (req: Request, { params }: Ctx) => {
  const parsed = query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) throw new HttpError(parsed.error.issues[0].message, 422);
  const { filename, kind: kindOverride } = parsed.data;

  const model = await prisma.model.findUnique({
    where: { id: params.id },
    select: { id: true },
  });
  if (!model) throw new HttpError('Model not found', 404);
  if (!req.body) throw new HttpError('Request has no body', 400);

  await ensureStorage();

  const name = safeName(filename);
  const { kind: detectedKind, technology } = classify(name);
  const kind = kindOverride ?? detectedKind;

  // Reserve the row first so the on-disk name carries the file's own id.
  const placeholder = await prisma.modelFile.create({
    data: {
      modelId: params.id,
      kind,
      technology,
      filename: name,
      storagePath: 'pending',
      mime: mimeFor(name),
      sizeBytes: BigInt(0),
    },
  });

  const relPath = modelFileRelPath(params.id, placeholder.id, name);

  let written;
  try {
    written = await writeStream(relPath, req.body);
  } catch (err) {
    await prisma.modelFile.delete({ where: { id: placeholder.id } }).catch(() => {});
    throw new HttpError(err instanceof Error ? err.message : 'Upload failed', 413);
  }

  // Mesh statistics need the bytes back, so only do it for geometry and only up
  // to a size where a full read is sane. Bigger meshes still catalogue fine,
  // just without volume figures.
  let stats = null;
  let finalKind = kind;
  const STATS_LIMIT = 400 * 1024 * 1024;

  if (kind === FileKind.MESH && written.size <= STATS_LIMIT) {
    try {
      const buf = await readFileBuffer(relPath);

      // A .3mf is either geometry or a slicer project; only the contents say
      // which. Decided here rather than in classify(), which sees a name only.
      if (/\.3mf$/i.test(name) && !kindOverride && is3mfProject(buf)) {
        finalKind = FileKind.PLATE;
      } else {
        stats = meshStats(name, buf);
      }
    } catch (err) {
      console.warn('[upload] could not inspect', name, err);
    }
  }

  const file = await prisma.modelFile.update({
    where: { id: placeholder.id },
    data: {
      kind: finalKind,
      storagePath: relPath,
      sizeBytes: BigInt(written.size),
      sha256: written.sha256,
      triangles: stats?.triangles ?? null,
      bboxX: stats?.bbox.x ?? null,
      bboxY: stats?.bbox.y ?? null,
      bboxZ: stats?.bbox.z ?? null,
      volumeMm3: stats?.volumeMm3 ?? null,
      meta: stats?.invertedNormals ? { invertedNormals: true } : undefined,
    },
  });

  // Touch the model so the library's "recent" ordering reflects new uploads.
  await prisma.model.update({
    where: { id: params.id },
    data: { updatedAt: new Date() },
  });

  return ok(file, { status: 201 });
});

const deleteQuery = z.object({ fileId: z.string().min(1) });

export const DELETE = handler(async (req: Request, { params }: Ctx) => {
  const parsed = deleteQuery.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) throw new HttpError('fileId is required', 422);

  const file = await prisma.modelFile.findFirst({
    where: { id: parsed.data.fileId, modelId: params.id },
  });
  if (!file) throw new HttpError('File not found on this model', 404);

  const activeJob = await prisma.printJob.findFirst({
    where: {
      fileId: file.id,
      status: { in: ['QUEUED', 'UPLOADING', 'STARTING', 'PRINTING', 'PAUSED'] },
    },
    select: { id: true },
  });
  if (activeJob) {
    throw new HttpError('That file is part of a print job that is still running', 409);
  }

  await prisma.modelFile.delete({ where: { id: file.id } });
  await removeQuietly(file.storagePath);

  return ok({ deleted: file.id });
});

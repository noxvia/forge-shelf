import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { FileKind } from '@prisma/client';
import { prisma } from '@/lib/db';
import { ok, handler, HttpError } from '@/lib/json';
import { absPath, sliceDirRelPath, safeName, ensureStorage } from '@/lib/storage';
import { bakePlate } from '@/lib/tools/plate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 600;

type Ctx = { params: { id: string } };

const body = z.object({
  /** 3mf keeps the objects separate; stl merges everything into one solid. */
  format: z.enum(['3mf', 'stl']).default('3mf'),
});

/**
 * Bakes the arrangement into one file and files it back into the catalogue.
 *
 * Runs inline rather than through the worker: baking is a geometry pass over
 * meshes that are already on disk, and it finishes in seconds even for a full
 * plate. The export lands as a ModelFile owned by the plate rather than any one
 * model, so it can be downloaded, opened in a slicer, or sent to a printer once
 * sliced elsewhere.
 */
export const POST = handler(async (req: Request, { params }: Ctx) => {
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) throw new HttpError(parsed.error.issues[0].message, 422);
  const { format } = parsed.data;

  const plate = await prisma.plate.findUnique({
    where: { id: params.id },
    include: {
      items: { include: { file: true }, orderBy: { createdAt: 'asc' } },
      printer: { select: { buildX: true, buildY: true, buildZ: true } },
    },
  });
  if (!plate) throw new HttpError('Plate not found', 404);
  if (plate.items.length === 0) {
    throw new HttpError('This plate is empty — add a model to it first', 422);
  }

  await ensureStorage();
  const workRel = sliceDirRelPath(`plate-${plate.id}`);
  const workDir = absPath(workRel);
  await fsp.mkdir(workDir, { recursive: true });

  const outName = safeName(`${plate.name}.${format}`);
  const outRel = path.posix.join(workRel, outName);
  const printer = plate.printer;

  const baked = await bakePlate(
    plate.items.map((i) => ({
      path: absPath(i.file.storagePath),
      name: i.file.filename,
      posX: i.posX, posY: i.posY, posZ: i.posZ,
      rotX: i.rotX, rotY: i.rotY, rotZ: i.rotZ,
      scale: i.scale,
    })),
    absPath(outRel),
    {
      format,
      plate:
        printer?.buildX && printer.buildY && printer.buildZ
          ? { x: printer.buildX, y: printer.buildY, z: printer.buildZ }
          : null,
      workDir,
    },
  );

  if (!baked.ok) throw new HttpError(`Could not export the plate: ${baked.error}`, 500);

  // Warn but don't refuse — you may be exporting deliberately oversized work to
  // rescale in the slicer.
  const warnings: string[] = [];
  if (baked.fits === false) {
    warnings.push(
      `This arrangement is larger than the printer's build volume in ` +
        `${baked.exceeds?.join(' and ')}. It will need rescaling or rearranging before it prints.`,
    );
  }

  const stat = await fsp.stat(absPath(outRel));

  // One current export per plate; replacing keeps the library tidy.
  const previous = await prisma.modelFile.findMany({
    where: { plateId: plate.id },
    select: { id: true },
  });
  if (previous.length > 0) {
    await prisma.modelFile.deleteMany({ where: { id: { in: previous.map((p) => p.id) } } });
  }

  const file = await prisma.modelFile.create({
    data: {
      modelId: null,
      plateId: plate.id,
      kind: FileKind.MESH,
      filename: outName,
      storagePath: outRel,
      mime: format === '3mf' ? 'model/3mf' : 'model/stl',
      sizeBytes: BigInt(stat.size),
      triangles: baked.triangles ?? null,
      bboxX: baked.sizeMm?.[0] ?? null,
      bboxY: baked.sizeMm?.[1] ?? null,
      bboxZ: baked.sizeMm?.[2] ?? null,
      meta: {
        plate: { id: plate.id, name: plate.name, items: baked.items },
        sizeMm: baked.sizeMm,
        fits: baked.fits,
      } as never,
    },
  });

  await prisma.plate.update({ where: { id: plate.id }, data: { updatedAt: new Date() } });

  return ok({ file, objects: baked.items, sizeMm: baked.sizeMm, warnings }, { status: 201 });
});

import { z } from 'zod';
import { FileKind } from '@prisma/client';
import { prisma } from '@/lib/db';
import { ok, handler, HttpError } from '@/lib/json';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: { id: string } };

const PLATE_INCLUDE = {
  items: {
    orderBy: { createdAt: 'asc' },
    include: {
      file: {
        select: {
          id: true,
          filename: true,
          sizeBytes: true,
          bboxX: true,
          bboxY: true,
          bboxZ: true,
          triangles: true,
          modelId: true,
          model: { select: { id: true, name: true } },
        },
      },
    },
  },
  printer: {
    select: { id: true, name: true, kind: true, buildX: true, buildY: true, buildZ: true },
  },
} as const;

export const GET = handler(async (_req: Request, { params }: Ctx) => {
  const plate = await prisma.plate.findUnique({
    where: { id: params.id },
    include: PLATE_INCLUDE,
  });
  if (!plate) throw new HttpError('Plate not found', 404);

  const exports = await prisma.modelFile.findMany({
    where: { plateId: params.id },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { id: true, filename: true, sizeBytes: true, createdAt: true, meta: true },
  });

  return ok({ ...plate, exports });
});

const transform = {
  posX: z.number().optional(),
  posY: z.number().optional(),
  posZ: z.number().optional(),
  rotX: z.number().min(-360).max(360).optional(),
  rotY: z.number().min(-360).max(360).optional(),
  rotZ: z.number().min(-360).max(360).optional(),
  scale: z.number().min(0.01).max(100).optional(),
};

const patchBody = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  printerId: z.string().min(1).nullable().optional(),
  /** Add meshes to the plate. */
  addFileIds: z.array(z.string().min(1)).max(50).optional(),
  /** Remove items by their own id. */
  removeItemIds: z.array(z.string().min(1)).max(50).optional(),
  /** Bulk transform update — how the editor saves a drag. */
  items: z
    .array(z.object({ id: z.string().min(1), ...transform }))
    .max(200)
    .optional(),
});

export const PATCH = handler(async (req: Request, { params }: Ctx) => {
  const parsed = patchBody.safeParse(await req.json());
  if (!parsed.success) throw new HttpError(parsed.error.issues[0].message, 422);
  const { addFileIds, removeItemIds, items, ...rest } = parsed.data;

  const exists = await prisma.plate.findUnique({
    where: { id: params.id },
    select: { id: true },
  });
  if (!exists) throw new HttpError('Plate not found', 404);

  if (addFileIds?.length) {
    // Deduplicate before checking existence: putting four copies of the same
    // miniature on a plate is the normal case, and comparing row count against
    // the raw id count would reject it as "file not found".
    const unique = [...new Set(addFileIds)];
    const files = await prisma.modelFile.findMany({
      where: { id: { in: unique } },
      select: { id: true, kind: true, filename: true },
    });
    const notMesh = files.find((f) => f.kind !== FileKind.MESH);
    if (notMesh) {
      throw new HttpError(`${notMesh.filename} is not a mesh, so it cannot go on a plate`, 422);
    }
    if (files.length !== unique.length) {
      const found = new Set(files.map((f) => f.id));
      const missing = unique.filter((id) => !found.has(id));
      throw new HttpError(`File not found: ${missing.join(', ')}`, 404);
    }
  }

  await prisma.$transaction(async (tx) => {
    if (removeItemIds?.length) {
      await tx.plateItem.deleteMany({
        where: { id: { in: removeItemIds }, plateId: params.id },
      });
    }
    if (addFileIds?.length) {
      await tx.plateItem.createMany({
        data: addFileIds.map((fileId) => ({ plateId: params.id, fileId })),
      });
    }
    for (const item of items ?? []) {
      const { id, ...t } = item;
      // Scoped by plateId so one plate cannot move another's items.
      await tx.plateItem.updateMany({ where: { id, plateId: params.id }, data: t });
    }
    await tx.plate.update({
      where: { id: params.id },
      data: rest,
    });
  });

  const plate = await prisma.plate.findUnique({
    where: { id: params.id },
    include: PLATE_INCLUDE,
  });
  return ok(plate);
});

export const DELETE = handler(async (_req: Request, { params }: Ctx) => {
  await prisma.plate.delete({ where: { id: params.id } });
  return ok({ deleted: params.id });
});

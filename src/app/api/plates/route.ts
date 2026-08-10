import { z } from 'zod';
import { FileKind } from '@prisma/client';
import { prisma } from '@/lib/db';
import { ok, handler, HttpError } from '@/lib/json';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  const plates = await prisma.plate.findMany({
    orderBy: { updatedAt: 'desc' },
    include: {
      printer: { select: { id: true, name: true, kind: true, buildX: true, buildY: true, buildZ: true } },
      _count: { select: { items: true } },
    },
  });
  return ok(plates);
});

const createBody = z.object({
  name: z.string().trim().min(1).max(160),
  printerId: z.string().min(1).nullable().optional(),
  /** Optional starting mesh, so "arrange this model" is one step. */
  fileId: z.string().min(1).optional(),
});

export const POST = handler(async (req: Request) => {
  const parsed = createBody.safeParse(await req.json());
  if (!parsed.success) throw new HttpError(parsed.error.issues[0].message, 422);
  const { name, printerId, fileId } = parsed.data;

  if (fileId) {
    const file = await prisma.modelFile.findUnique({
      where: { id: fileId },
      select: { id: true, kind: true, filename: true },
    });
    if (!file) throw new HttpError('File not found', 404);
    if (file.kind !== FileKind.MESH) {
      throw new HttpError(`${file.filename} is not a mesh, so it cannot go on a plate`, 422);
    }
  }

  const plate = await prisma.plate.create({
    data: {
      name,
      printerId: printerId ?? null,
      items: fileId ? { create: [{ fileId }] } : undefined,
    },
    include: {
      items: { include: { file: true } },
      printer: { select: { id: true, name: true, buildX: true, buildY: true, buildZ: true } },
    },
  });

  return ok(plate, { status: 201 });
});

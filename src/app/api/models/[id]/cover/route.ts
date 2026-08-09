import { z } from 'zod';
import { FileKind } from '@prisma/client';
import { prisma } from '@/lib/db';
import { ok, handler, HttpError } from '@/lib/json';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: { id: string } };

const body = z.object({
  /** An uploaded image on this model, or null to fall back to the 3D capture. */
  fileId: z.string().min(1).nullable(),
});

/**
 * Chooses which image represents the model in the library.
 *
 * Points at the uploaded file rather than copying it, so replacing the cover is
 * instant and there is only ever one copy of the bytes. The thumbnail route
 * prefers this over the renderer-captured PNG.
 */
export const PUT = handler(async (req: Request, { params }: Ctx) => {
  const parsed = body.safeParse(await req.json());
  if (!parsed.success) throw new HttpError(parsed.error.issues[0].message, 422);
  const { fileId } = parsed.data;

  const model = await prisma.model.findUnique({
    where: { id: params.id },
    select: { id: true },
  });
  if (!model) throw new HttpError('Model not found', 404);

  if (fileId === null) {
    const updated = await prisma.model.update({
      where: { id: params.id },
      data: { thumbnailPath: null },
      select: { id: true, thumbnailPath: true },
    });
    return ok(updated);
  }

  const file = await prisma.modelFile.findFirst({
    where: { id: fileId, modelId: params.id },
    select: { id: true, kind: true, filename: true, storagePath: true, mime: true },
  });
  if (!file) throw new HttpError('That image is not on this model', 404);
  if (file.kind !== FileKind.IMAGE) {
    throw new HttpError(`${file.filename} is not an image`, 422);
  }

  const updated = await prisma.model.update({
    where: { id: params.id },
    data: { thumbnailPath: file.storagePath },
    select: { id: true, thumbnailPath: true },
  });

  return ok({ ...updated, coverFileId: file.id });
});

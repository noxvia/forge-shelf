import { prisma } from '@/lib/db';
import { ok, handler, HttpError } from '@/lib/json';
import { thumbRelPath, writeBuffer, ensureStorage } from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: { id: string } };

/**
 * PUT /api/models/:id/thumbnail  — raw PNG body.
 *
 * Thumbnails are rendered in the browser by the three.js viewer and posted back,
 * which avoids shipping a headless GL stack in the container just to make
 * pictures. Renders that never get viewed simply never get a thumbnail.
 */
export const PUT = handler(async (req: Request, { params }: Ctx) => {
  const model = await prisma.model.findUnique({
    where: { id: params.id },
    select: { id: true },
  });
  if (!model) throw new HttpError('Model not found', 404);
  if (!req.body) throw new HttpError('Request has no body', 400);

  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.length === 0) throw new HttpError('Empty thumbnail', 400);
  if (buf.length > 4 * 1024 * 1024) throw new HttpError('Thumbnail too large', 413);

  // PNG magic number — refuse anything else so the file we serve back is safe.
  const isPng = buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (!isPng) throw new HttpError('Thumbnail must be a PNG', 415);

  await ensureStorage();
  const relPath = thumbRelPath(params.id);
  await writeBuffer(relPath, buf);

  await prisma.model.update({
    where: { id: params.id },
    data: { thumbnailPath: relPath },
  });

  return ok({ thumbnailPath: relPath });
});

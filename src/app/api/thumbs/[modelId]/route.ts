import fs from 'node:fs';
import { Readable } from 'node:stream';
import { prisma } from '@/lib/db';
import { handler } from '@/lib/json';
import { absPath, statOrNull, thumbRelPath, mimeFor } from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: { modelId: string } };

/** A neutral 1×1 PNG, so a missing thumbnail renders as an empty tile. */
const BLANK = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

/**
 * Serves the library tile image.
 *
 * An uploaded cover image wins when one has been chosen — model.thumbnailPath
 * points straight at it. Otherwise this falls back to the PNG the 3D viewer
 * captured, so models with no artwork still get a picture.
 */
export const GET = handler(async (_req: Request, { params }: Ctx) => {
  const model = await prisma.model
    .findUnique({ where: { id: params.modelId }, select: { thumbnailPath: true } })
    .catch(() => null);

  const candidates = [model?.thumbnailPath, thumbRelPath(params.modelId)].filter(
    (p): p is string => Boolean(p),
  );

  for (const rel of candidates) {
    const stat = await statOrNull(rel).catch(() => null);
    if (!stat) continue;

    const stream = fs.createReadStream(absPath(rel));
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      headers: {
        'content-type': mimeFor(rel).startsWith('image/') ? mimeFor(rel) : 'image/png',
        'content-length': String(stat.size),
        // Covers are replaced in place, so revalidate rather than cache hard.
        'cache-control': 'private, max-age=0, must-revalidate',
        etag: `"${stat.mtimeMs}-${stat.size}"`,
      },
    });
  }

  return new Response(BLANK, {
    headers: { 'content-type': 'image/png', 'cache-control': 'no-store' },
  });
});

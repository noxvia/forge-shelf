import fs from 'node:fs';
import { Readable } from 'node:stream';
import { handler } from '@/lib/json';
import { absPath, statOrNull, thumbRelPath } from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: { modelId: string } };

/** A neutral 1×1 PNG, so a missing thumbnail renders as an empty tile. */
const BLANK = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

export const GET = handler(async (_req: Request, { params }: Ctx) => {
  const rel = thumbRelPath(params.modelId);
  const stat = await statOrNull(rel);

  if (!stat) {
    return new Response(BLANK, {
      headers: { 'content-type': 'image/png', 'cache-control': 'no-store' },
    });
  }

  const stream = fs.createReadStream(absPath(rel));
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: {
      'content-type': 'image/png',
      'content-length': String(stat.size),
      // Thumbnails are overwritten in place, so revalidate rather than cache hard.
      'cache-control': 'private, max-age=0, must-revalidate',
      etag: `"${stat.mtimeMs}-${stat.size}"`,
    },
  });
});

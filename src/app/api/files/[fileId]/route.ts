import fs from 'node:fs';
import { Readable } from 'node:stream';
import { prisma } from '@/lib/db';
import { handler, HttpError } from '@/lib/json';
import { absPath, statOrNull } from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: { fileId: string } };

/**
 * Serves a stored file. Supports Range requests so the viewer can stream large
 * meshes and the browser can resume interrupted downloads.
 *
 * `?download=1` forces a save dialog instead of inline rendering.
 */
export const GET = handler(async (req: Request, { params }: Ctx) => {
  const file = await prisma.modelFile.findUnique({ where: { id: params.fileId } });
  if (!file) throw new HttpError('File not found', 404);

  const stat = await statOrNull(file.storagePath);
  if (!stat) throw new HttpError('File is recorded but missing from storage', 410);

  const wantsDownload = new URL(req.url).searchParams.get('download') === '1';
  const disposition = wantsDownload ? 'attachment' : 'inline';

  const baseHeaders: Record<string, string> = {
    'content-type': file.mime ?? 'application/octet-stream',
    'accept-ranges': 'bytes',
    'content-disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    // Content is immutable per file id, so let the browser keep it.
    'cache-control': 'private, max-age=31536000, immutable',
    etag: file.sha256 ? `"${file.sha256}"` : `"${file.id}-${stat.size}"`,
  };

  const absolute = absPath(file.storagePath);
  const range = req.headers.get('range');

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match) {
      const size = stat.size;
      let start = match[1] ? Number(match[1]) : 0;
      let end = match[2] ? Number(match[2]) : size - 1;

      // Suffix form: "bytes=-500" means the last 500 bytes.
      if (!match[1] && match[2]) {
        start = Math.max(0, size - Number(match[2]));
        end = size - 1;
      }

      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
        return new Response(null, {
          status: 416,
          headers: { 'content-range': `bytes */${size}` },
        });
      }
      end = Math.min(end, size - 1);

      const stream = fs.createReadStream(absolute, { start, end });
      return new Response(Readable.toWeb(stream) as ReadableStream, {
        status: 206,
        headers: {
          ...baseHeaders,
          'content-range': `bytes ${start}-${end}/${size}`,
          'content-length': String(end - start + 1),
        },
      });
    }
  }

  const stream = fs.createReadStream(absolute);
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: { ...baseHeaders, 'content-length': String(stat.size) },
  });
});

import { prisma } from '@/lib/db';
import { ok, handler, HttpError } from '@/lib/json';
import { toHostPath, openInUri, OPENABLE_APPS } from '@/lib/host-path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: { fileId: string } };

/**
 * Everything the UI needs to offer "open in a desktop slicer".
 *
 * The host path is computed here rather than in the browser: it depends on
 * HOST_DATA_DIR, which is server configuration. When that isn't set the
 * response says so and the UI degrades to download-only instead of handing out
 * a path that won't resolve.
 */
export const GET = handler(async (_req: Request, { params }: Ctx) => {
  const file = await prisma.modelFile.findUnique({
    where: { id: params.fileId },
    select: { id: true, filename: true, kind: true, storagePath: true },
  });
  if (!file) throw new HttpError('File not found', 404);

  const hostPath = toHostPath(file.storagePath);

  if (!hostPath) {
    return ok({
      fileId: file.id,
      filename: file.filename,
      hostPath: null,
      apps: [],
      reason:
        'HOST_DATA_DIR is not set, so the catalogue does not know where its files appear on ' +
        'this machine. Set it to the folder the ./data volume points at and restart.',
    });
  }

  const apps = OPENABLE_APPS.filter((a) => a.kinds.includes(file.kind as never)).map((a) => ({
    key: a.key,
    label: a.label,
    uri: openInUri(a.key, hostPath),
  }));

  return ok({ fileId: file.id, filename: file.filename, hostPath, apps, reason: null });
});

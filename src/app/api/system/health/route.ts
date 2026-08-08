import { prisma } from '@/lib/db';
import { ok, handler } from '@/lib/json';
import { toolStatus } from '@/lib/slicer';
import { env } from '@/lib/env';
import { statOrNull } from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Diagnostics. Chiefly answers "why can't I slice?", which is almost always a
 * slicer binary that didn't make it into the image.
 */
export const GET = handler(async () => {
  const [tools, dbOk, storage, counts, workerHeartbeat] = await Promise.all([
    toolStatus(),
    prisma
      .$queryRaw`SELECT 1`.then(() => true)
      .catch(() => false),
    statOrNull('.'),
    Promise.all([
      prisma.model.count().catch(() => -1),
      prisma.modelFile.count().catch(() => -1),
      prisma.printer.count().catch(() => -1),
      prisma.printJob.count().catch(() => -1),
    ]),
    // The worker touches this row every loop; a stale timestamp means it died.
    prisma.sliceTask
      .findFirst({ where: { status: 'RUNNING' }, select: { id: true, startedAt: true } })
      .catch(() => null),
  ]);

  const [models, files, printers, jobs] = counts;

  return ok({
    ok: dbOk && Boolean(storage),
    database: { reachable: dbOk },
    storage: { path: env.storageDir, writable: Boolean(storage) },
    slicers: tools,
    counts: { models, files, printers, jobs },
    runningSlice: workerHeartbeat,
    notes: tools
      .filter((t) => !t.installed)
      .map((t) => `${t.name} is missing at ${t.path} — ${t.purpose.toLowerCase()} is unavailable.`),
  });
});

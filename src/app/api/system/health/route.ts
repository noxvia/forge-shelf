import { prisma } from '@/lib/db';
import { ok, handler } from '@/lib/json';
import { env } from '@/lib/env';
import { statOrNull } from '@/lib/storage';
import { toolStatus } from '@/lib/tools/status';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Diagnostics. Chiefly answers "why can't I inspect or export?", which is
 * almost always a helper binary that didn't make it into the image.
 */
export const GET = handler(async () => {
  const [tools, dbOk, storage, counts] = await Promise.all([
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
      prisma.plate.count().catch(() => -1),
    ]),
  ]);

  const [models, files, printers, jobs, plates] = counts;

  return ok({
    ok: dbOk && Boolean(storage),
    database: { reachable: dbOk },
    storage: {
      path: env.storageDir,
      writable: Boolean(storage),
      // Needed for the "open in" buttons; null means they stay hidden.
      hostPath: env.hostDataDir,
    },
    tools,
    counts: { models, files, printers, jobs, plates },
    notes: tools
      .filter((t) => !t.installed)
      .map((t) => `${t.name} is missing at ${t.path} — ${t.purpose.toLowerCase()} is unavailable.`),
  });
});

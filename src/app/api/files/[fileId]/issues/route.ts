import { FileKind, Technology } from '@prisma/client';
import { prisma } from '@/lib/db';
import { ok, handler, HttpError } from '@/lib/json';
import { absPath, statOrNull } from '@/lib/storage';
import { checkPrintIssues, summariseIssues } from '@/lib/slicer/issues';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Detection walks every layer; a tall print legitimately takes minutes.
export const maxDuration = 900;

type Ctx = { params: { fileId: string } };

/** Returns the stored report without re-running anything. */
export const GET = handler(async (_req: Request, { params }: Ctx) => {
  const file = await prisma.modelFile.findUnique({
    where: { id: params.fileId },
    select: { id: true, filename: true, meta: true },
  });
  if (!file) throw new HttpError('File not found', 404);

  const meta = (file.meta ?? {}) as Record<string, unknown>;
  return ok({ fileId: file.id, filename: file.filename, issues: meta.issues ?? null });
});

/**
 * Runs risk detection on demand.
 *
 * Useful for files that never went through the slicer here — a .ctb exported
 * from ChiTuBox or Lychee gets the same check as one this app produced.
 */
export const POST = handler(async (_req: Request, { params }: Ctx) => {
  const file = await prisma.modelFile.findUnique({ where: { id: params.fileId } });
  if (!file) throw new HttpError('File not found', 404);

  if (file.kind !== FileKind.SLICED) {
    throw new HttpError(
      `${file.filename} is not a sliced file. Risk detection reads printed layers, so it ` +
        `only applies to machine-ready output.`,
      422,
    );
  }
  if (file.technology === Technology.FDM) {
    throw new HttpError(
      'Risk detection is resin-only — it looks for trapped resin, islands and suction cups.',
      422,
    );
  }
  if (!(await statOrNull(file.storagePath))) {
    throw new HttpError('File is recorded but missing from storage', 410);
  }

  const report = await checkPrintIssues(absPath(file.storagePath));

  const meta = { ...((file.meta ?? {}) as Record<string, unknown>), issues: report };
  await prisma.modelFile.update({
    where: { id: file.id },
    data: { meta: meta as never },
  });

  console.log(`[issues] ${file.filename}: ${summariseIssues(report)}`);
  return ok({ fileId: file.id, filename: file.filename, issues: report });
});

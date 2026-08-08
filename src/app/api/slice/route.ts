import { z } from 'zod';
import { FileKind } from '@prisma/client';
import { prisma } from '@/lib/db';
import { ok, handler, HttpError } from '@/lib/json';
import { technologyFor } from '@/lib/printers';
import { sliceOptionsSchema, slaOptionWarnings } from '@/lib/slicer/options';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const body = z.object({
  fileId: z.string().min(1),
  profileId: z.string().min(1),
  /** Queue a print on this printer as soon as the slice succeeds. */
  autoPrintPrinterId: z.string().min(1).nullable().optional(),
  /** Per-slice overrides layered on top of the profile. */
  options: sliceOptionsSchema.optional(),
});

/**
 * Queues a slice. The work itself happens in the worker process — slicing takes
 * minutes and must survive a browser tab closing.
 */
export const POST = handler(async (req: Request) => {
  const parsed = body.safeParse(await req.json());
  if (!parsed.success) throw new HttpError(parsed.error.issues[0].message, 422);
  const { fileId, profileId, autoPrintPrinterId, options } = parsed.data;

  const file = await prisma.modelFile.findUnique({
    where: { id: fileId },
    select: { id: true, kind: true, filename: true, modelId: true },
  });
  if (!file) throw new HttpError('File not found', 404);
  if (file.kind !== FileKind.MESH) {
    throw new HttpError(`${file.filename} is not a mesh — there is nothing to slice`, 422);
  }

  const profile = await prisma.slicerProfile.findUnique({ where: { id: profileId } });
  if (!profile) throw new HttpError('Slicer profile not found', 404);

  if (autoPrintPrinterId) {
    const printer = await prisma.printer.findUnique({
      where: { id: autoPrintPrinterId },
      select: { id: true, kind: true, name: true, enabled: true },
    });
    if (!printer) throw new HttpError('Printer not found', 404);
    if (!printer.enabled) throw new HttpError(`${printer.name} is disabled`, 409);

    // Catch the mismatch here rather than after a ten-minute slice.
    if (technologyFor(printer.kind) !== profile.technology) {
      throw new HttpError(
        `Profile "${profile.name}" produces ${profile.technology} output, but ` +
          `${printer.name} is a ${technologyFor(printer.kind)} printer.`,
        422,
      );
    }
  }

  const existing = await prisma.sliceTask.findFirst({
    where: { inputFileId: fileId, profileId, status: { in: ['QUEUED', 'RUNNING'] } },
    select: { id: true },
  });
  if (existing) {
    throw new HttpError('That file is already queued for slicing with this profile', 409);
  }

  const task = await prisma.sliceTask.create({
    data: {
      inputFileId: fileId,
      profileId,
      autoPrintPrinterId: autoPrintPrinterId ?? null,
      options: options ? (options as never) : undefined,
    },
    include: {
      profile: { select: { name: true, technology: true, outputFormat: true } },
      inputFile: { select: { filename: true, modelId: true } },
    },
  });

  // Not blocking — these are print-safety notes, not validation failures. The
  // UI shows them so an unattended hollow print doesn't surprise anyone.
  return ok({ ...task, warnings: slaOptionWarnings(options) }, { status: 202 });
});

export const GET = handler(async (req: Request) => {
  const url = new URL(req.url);
  const modelId = url.searchParams.get('modelId');
  const active = url.searchParams.get('active') === 'true';

  const tasks = await prisma.sliceTask.findMany({
    where: {
      ...(modelId ? { inputFile: { modelId } } : {}),
      ...(active ? { status: { in: ['QUEUED', 'RUNNING'] } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: {
      profile: { select: { id: true, name: true, technology: true, outputFormat: true } },
      inputFile: { select: { id: true, filename: true, modelId: true } },
      outputFile: { select: { id: true, filename: true, sizeBytes: true, meta: true } },
    },
  });

  return ok(tasks);
});

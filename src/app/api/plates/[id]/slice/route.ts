import { z } from 'zod';
import { prisma } from '@/lib/db';
import { ok, handler, HttpError } from '@/lib/json';
import { technologyFor } from '@/lib/printers';
import { sliceOptionsSchema, slaOptionWarnings } from '@/lib/slicer/options';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: { id: string } };

const body = z.object({
  profileId: z.string().min(1).optional(),
  autoPrintPrinterId: z.string().min(1).nullable().optional(),
  options: sliceOptionsSchema.optional(),
});

/**
 * Queues a whole plate. The worker bakes the arrangement into one mesh and then
 * takes exactly the same path as a single-model slice — same risk detection,
 * same print dispatch.
 */
export const POST = handler(async (req: Request, { params }: Ctx) => {
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) throw new HttpError(parsed.error.issues[0].message, 422);
  const { autoPrintPrinterId, options } = parsed.data;

  const plate = await prisma.plate.findUnique({
    where: { id: params.id },
    include: { items: { select: { id: true } } },
  });
  if (!plate) throw new HttpError('Plate not found', 404);
  if (plate.items.length === 0) {
    throw new HttpError('This plate is empty — add a model to it first', 422);
  }

  const profileId = parsed.data.profileId ?? plate.profileId;
  if (!profileId) {
    throw new HttpError('Choose a slicer profile for this plate', 422);
  }
  const profile = await prisma.slicerProfile.findUnique({ where: { id: profileId } });
  if (!profile) throw new HttpError('Slicer profile not found', 404);

  if (autoPrintPrinterId) {
    const printer = await prisma.printer.findUnique({
      where: { id: autoPrintPrinterId },
      select: { id: true, name: true, kind: true, enabled: true },
    });
    if (!printer) throw new HttpError('Printer not found', 404);
    if (!printer.enabled) throw new HttpError(`${printer.name} is disabled`, 409);
    if (technologyFor(printer.kind) !== profile.technology) {
      throw new HttpError(
        `Profile "${profile.name}" produces ${profile.technology} output, but ` +
          `${printer.name} is a ${technologyFor(printer.kind)} printer.`,
        422,
      );
    }
  }

  const busy = await prisma.sliceTask.findFirst({
    where: { plateId: params.id, status: { in: ['QUEUED', 'RUNNING'] } },
    select: { id: true },
  });
  if (busy) throw new HttpError('This plate is already queued for slicing', 409);

  const task = await prisma.$transaction(async (tx) => {
    // Remember the choices so re-slicing the plate is one click.
    await tx.plate.update({
      where: { id: params.id },
      data: { profileId, ...(options ? { options: options as never } : {}) },
    });
    return tx.sliceTask.create({
      data: {
        plateId: params.id,
        profileId,
        autoPrintPrinterId: autoPrintPrinterId ?? null,
        options: options ? (options as never) : undefined,
      },
      include: { profile: { select: { name: true, technology: true, outputFormat: true } } },
    });
  });

  return ok({ ...task, warnings: slaOptionWarnings(options) }, { status: 202 });
});

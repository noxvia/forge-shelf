import { z } from 'zod';
import { PrinterKind } from '@prisma/client';
import { prisma } from '@/lib/db';
import { ok, handler, HttpError } from '@/lib/json';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: { id: string } };

export const GET = handler(async (_req: Request, { params }: Ctx) => {
  const profile = await prisma.slicerProfile.findUnique({ where: { id: params.id } });
  if (!profile) throw new HttpError('Profile not found', 404);
  return ok(profile);
});

const patchBody = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  printerKind: z.nativeEnum(PrinterKind).nullable().optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  machineConfig: z.string().max(2_000_000).nullable().optional(),
  processConfig: z.string().max(2_000_000).nullable().optional(),
  materialConfig: z.string().max(2_000_000).nullable().optional(),
  outputFormat: z.string().trim().min(1).max(20).optional(),
  extraArgs: z.string().trim().max(1000).nullable().optional(),
  isDefault: z.boolean().optional(),
});

export const PATCH = handler(async (req: Request, { params }: Ctx) => {
  const parsed = patchBody.safeParse(await req.json());
  if (!parsed.success) throw new HttpError(parsed.error.issues[0].message, 422);
  const data = parsed.data;

  const existing = await prisma.slicerProfile.findUnique({ where: { id: params.id } });
  if (!existing) throw new HttpError('Profile not found', 404);

  const profile = await prisma.$transaction(async (tx) => {
    const updated = await tx.slicerProfile.update({
      where: { id: params.id },
      data: {
        ...data,
        ...(data.outputFormat
          ? { outputFormat: data.outputFormat.replace(/^\./, '').toLowerCase() }
          : {}),
      },
    });
    if (data.isDefault) {
      await tx.slicerProfile.updateMany({
        where: { technology: existing.technology, id: { not: params.id } },
        data: { isDefault: false },
      });
    }
    return updated;
  });

  return ok(profile);
});

export const DELETE = handler(async (_req: Request, { params }: Ctx) => {
  const inUse = await prisma.sliceTask.findFirst({
    where: { profileId: params.id, status: { in: ['QUEUED', 'RUNNING'] } },
    select: { id: true },
  });
  if (inUse) throw new HttpError('This profile is being used by a running slice', 409);

  // Historical tasks reference the profile, so refuse rather than orphan them.
  const referenced = await prisma.sliceTask.count({ where: { profileId: params.id } });
  if (referenced > 0) {
    throw new HttpError(
      `This profile is referenced by ${referenced} past slice${referenced === 1 ? '' : 's'}. ` +
        `Delete those first if you really want it gone.`,
      409,
    );
  }

  await prisma.slicerProfile.delete({ where: { id: params.id } });
  return ok({ deleted: params.id });
});

import { z } from 'zod';
import { PrinterKind, Technology } from '@prisma/client';
import { prisma } from '@/lib/db';
import { ok, handler, HttpError } from '@/lib/json';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async (req: Request) => {
  const tech = new URL(req.url).searchParams.get('technology');
  const profiles = await prisma.slicerProfile.findMany({
    where: tech === 'FDM' || tech === 'SLA' ? { technology: tech as Technology } : {},
    orderBy: [{ technology: 'asc' }, { isDefault: 'desc' }, { name: 'asc' }],
  });
  return ok(profiles);
});

const upsertBody = z.object({
  name: z.string().trim().min(1).max(160),
  technology: z.nativeEnum(Technology),
  printerKind: z.nativeEnum(PrinterKind).nullable().optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  machineConfig: z.string().max(2_000_000).nullable().optional(),
  processConfig: z.string().max(2_000_000).nullable().optional(),
  materialConfig: z.string().max(2_000_000).nullable().optional(),
  outputFormat: z
    .string()
    .trim()
    .min(1)
    .max(20)
    .regex(/^[a-z0-9.]+$/i, 'Output format should be an extension like ctb or gcode.3mf'),
  extraArgs: z.string().trim().max(1000).nullable().optional(),
  isDefault: z.boolean().optional(),
});

export const POST = handler(async (req: Request) => {
  const parsed = upsertBody.safeParse(await req.json());
  if (!parsed.success) throw new HttpError(parsed.error.issues[0].message, 422);
  const data = parsed.data;

  const clash = await prisma.slicerProfile.findUnique({
    where: { name: data.name },
    select: { id: true },
  });
  if (clash) throw new HttpError(`A profile named "${data.name}" already exists`, 409);

  const profile = await prisma.$transaction(async (tx) => {
    const created = await tx.slicerProfile.create({
      data: { ...data, outputFormat: data.outputFormat.replace(/^\./, '').toLowerCase() },
    });
    if (data.isDefault) {
      // Only one default per technology.
      await tx.slicerProfile.updateMany({
        where: { technology: data.technology, id: { not: created.id } },
        data: { isDefault: false },
      });
    }
    return created;
  });

  return ok(profile, { status: 201 });
});

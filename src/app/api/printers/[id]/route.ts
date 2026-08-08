import { z } from 'zod';
import { prisma } from '@/lib/db';
import { ok, handler, HttpError } from '@/lib/json';
import { encryptSecret } from '@/lib/crypto';
import { PRINTER_SAFE_SELECT } from '@/lib/printers/select';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: { id: string } };

export const GET = handler(async (_req: Request, { params }: Ctx) => {
  const printer = await prisma.printer.findUnique({
    where: { id: params.id },
    select: {
      ...PRINTER_SAFE_SELECT,
      secretEnc: true,
      jobs: {
        orderBy: { queuedAt: 'desc' },
        take: 20,
        include: {
          file: { select: { id: true, filename: true } },
          model: { select: { id: true, name: true } },
        },
      },
    },
  });
  if (!printer) throw new HttpError('Printer not found', 404);

  const { secretEnc, ...safe } = printer;
  return ok({ ...safe, hasSecret: Boolean(secretEnc) });
});

const patchBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  host: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(/^[A-Za-z0-9._-]+$/, 'Host must be an IP address or hostname')
    .optional(),
  port: z.coerce.number().int().min(1).max(65535).nullable().optional(),
  serial: z.string().trim().max(120).nullable().optional(),
  /** Send null to clear the stored code, omit to leave it untouched. */
  accessCode: z.string().trim().max(200).nullable().optional(),
  modelName: z.string().trim().max(120).nullable().optional(),
  buildX: z.coerce.number().positive().nullable().optional(),
  buildY: z.coerce.number().positive().nullable().optional(),
  buildZ: z.coerce.number().positive().nullable().optional(),
  enabled: z.boolean().optional(),
});

export const PATCH = handler(async (req: Request, { params }: Ctx) => {
  const parsed = patchBody.safeParse(await req.json());
  if (!parsed.success) throw new HttpError(parsed.error.issues[0].message, 422);
  const { accessCode, ...rest } = parsed.data;

  const existing = await prisma.printer.findUnique({
    where: { id: params.id },
    select: { id: true },
  });
  if (!existing) throw new HttpError('Printer not found', 404);

  const printer = await prisma.printer.update({
    where: { id: params.id },
    data: {
      ...rest,
      ...(accessCode === undefined
        ? {}
        : { secretEnc: accessCode === null || accessCode === '' ? null : encryptSecret(accessCode) }),
      // A settings change invalidates whatever we last knew.
      lastError: null,
    },
    select: PRINTER_SAFE_SELECT,
  });

  return ok(printer);
});

export const DELETE = handler(async (_req: Request, { params }: Ctx) => {
  const active = await prisma.printJob.findFirst({
    where: {
      printerId: params.id,
      status: { in: ['QUEUED', 'UPLOADING', 'STARTING', 'PRINTING', 'PAUSED'] },
    },
    select: { id: true },
  });
  if (active) {
    throw new HttpError(
      'This printer has a job in flight. Cancel it before removing the printer.',
      409,
    );
  }

  await prisma.printer.delete({ where: { id: params.id } });
  return ok({ deleted: params.id });
});

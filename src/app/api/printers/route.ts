import { z } from 'zod';
import { PrinterKind } from '@prisma/client';
import { prisma } from '@/lib/db';
import { ok, handler, HttpError } from '@/lib/json';
import { encryptSecret } from '@/lib/crypto';
import { PRINTER_SAFE_SELECT } from '@/lib/printers/select';
import { probeSdcpHost } from '@/lib/printers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  const printers = await prisma.printer.findMany({
    orderBy: [{ enabled: 'desc' }, { name: 'asc' }],
    select: {
      ...PRINTER_SAFE_SELECT,
      secretEnc: true,
      _count: { select: { jobs: true } },
    },
  });

  return ok(
    printers.map(({ secretEnc, ...p }) => ({ ...p, hasSecret: Boolean(secretEnc) })),
  );
});

const createBody = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.nativeEnum(PrinterKind),
  host: z
    .string()
    .trim()
    .min(1)
    .max(255)
    // Hostname or IPv4; keeps obviously bad input out of the connection layer.
    .regex(/^[A-Za-z0-9._-]+$/, 'Host must be an IP address or hostname'),
  port: z.coerce.number().int().min(1).max(65535).nullable().optional(),
  serial: z.string().trim().max(120).nullable().optional(),
  /** Bambu LAN access code. Ignored for SDCP, which has no authentication. */
  accessCode: z.string().trim().max(200).nullable().optional(),
  modelName: z.string().trim().max(120).nullable().optional(),
  buildX: z.coerce.number().positive().nullable().optional(),
  buildY: z.coerce.number().positive().nullable().optional(),
  buildZ: z.coerce.number().positive().nullable().optional(),
});

export const POST = handler(async (req: Request) => {
  const parsed = createBody.safeParse(await req.json());
  if (!parsed.success) throw new HttpError(parsed.error.issues[0].message, 422);
  const { accessCode, ...rest } = parsed.data;

  if (rest.kind === PrinterKind.FDM_BAMBU) {
    if (!rest.serial) {
      throw new HttpError(
        'Bambu printers need their serial number — it addresses the MQTT topics. ' +
          'Find it under Settings → Device on the printer.',
        422,
      );
    }
    if (!accessCode) {
      throw new HttpError(
        'Bambu printers need the LAN Access Code from Settings → Network on the printer.',
        422,
      );
    }
  }

  const duplicate = await prisma.printer.findFirst({
    where: { kind: rest.kind, host: rest.host },
    select: { id: true, name: true },
  });
  if (duplicate) {
    throw new HttpError(`"${duplicate.name}" is already configured at ${rest.host}`, 409);
  }

  // A resin printer added by IP has no mainboard ID, and SDCP cannot address a
  // single command without one. Ask the printer directly rather than making the
  // user hunt for it — a unicast probe works from inside Docker's bridge
  // network, where the broadcast sweep on the Printers page cannot reach.
  const details = { ...rest };
  if (details.kind === PrinterKind.RESIN_SDCP && !details.serial) {
    const found = await probeSdcpHost(details.host).catch(() => null);
    if (found) {
      details.serial = found.serial;
      details.modelName ??= found.modelName;
      details.buildX ??= found.buildX;
      details.buildY ??= found.buildY;
      details.buildZ ??= found.buildZ;
    } else {
      throw new HttpError(
        `Could not reach an SDCP printer at ${details.host}. Check the address and that ` +
          `the printer is powered on and on the network. If it is reachable but still ` +
          `won't identify itself, enter the mainboard ID manually.`,
        502,
      );
    }
  }

  const printer = await prisma.printer.create({
    data: {
      ...details,
      secretEnc: accessCode ? encryptSecret(accessCode) : null,
    },
    select: PRINTER_SAFE_SELECT,
  });

  return ok({ ...printer, hasSecret: Boolean(accessCode) }, { status: 201 });
});

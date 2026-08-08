import { z } from 'zod';
import { prisma } from '@/lib/db';
import { ok, handler, HttpError } from '@/lib/json';
import { adapterFor, connectionFor, PrinterError } from '@/lib/printers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: { id: string } };

const body = z.object({
  action: z.enum(['refresh', 'pause', 'resume', 'cancel']),
});

/**
 * Live control. These talk to the hardware synchronously, so they are the one
 * place a slow or unreachable printer shows up as a slow request — the adapters
 * cap that at roughly ten seconds.
 */
export const POST = handler(async (req: Request, { params }: Ctx) => {
  const parsed = body.safeParse(await req.json());
  if (!parsed.success) throw new HttpError(parsed.error.issues[0].message, 422);

  const printer = await prisma.printer.findUnique({ where: { id: params.id } });
  if (!printer) throw new HttpError('Printer not found', 404);

  const adapter = adapterFor(printer.kind);
  const target = connectionFor(printer);

  try {
    switch (parsed.data.action) {
      case 'pause':
        await adapter.pause(target);
        break;
      case 'resume':
        await adapter.resume(target);
        break;
      case 'cancel': {
        await adapter.cancel(target);
        // Reflect the cancellation locally so the jobs view doesn't lag.
        await prisma.printJob.updateMany({
          where: {
            printerId: printer.id,
            status: { in: ['PRINTING', 'PAUSED', 'STARTING', 'UPLOADING'] },
          },
          data: { status: 'CANCELLED', finishedAt: new Date() },
        });
        break;
      }
      case 'refresh':
        break;
    }

    const status = await adapter.status(target);

    const updated = await prisma.printer.update({
      where: { id: printer.id },
      data: {
        status: status.state,
        statusJson: status as never,
        lastSeenAt: new Date(),
        lastError: null,
      },
      select: { id: true, status: true, statusJson: true, lastSeenAt: true, lastError: true },
    });

    return ok(updated);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    await prisma.printer.update({
      where: { id: printer.id },
      data: { status: 'offline', lastError: message },
    });

    throw new HttpError(message, err instanceof PrinterError ? 502 : 500);
  }
});

import { JobStatus } from '@prisma/client';
import { prisma } from '../lib/db';
import { adapterFor, connectionFor, type PrinterStatus } from '../lib/printers';

/**
 * Refreshes every enabled printer and reconciles any job it's running.
 *
 * Printers are polled in parallel but each is independently guarded — one
 * unplugged machine must not stall the others.
 */
export async function pollPrinters(): Promise<void> {
  const printers = await prisma.printer.findMany({ where: { enabled: true } });
  if (printers.length === 0) return;

  await Promise.all(
    printers.map(async (printer) => {
      try {
        const adapter = adapterFor(printer.kind);
        const status = await adapter.status(connectionFor(printer));

        await prisma.printer.update({
          where: { id: printer.id },
          data: {
            status: status.state,
            statusJson: status as never,
            lastSeenAt: new Date(),
            lastError: null,
          },
        });

        await reconcileJob(printer.id, status);
      } catch (err) {
        const message = describe(err);
        await prisma.printer.update({
          where: { id: printer.id },
          data: { status: 'offline', lastError: message },
        });
        // Expected whenever a printer is powered off; keep it to one line.
        console.warn(`[poll] ${printer.name}: ${message}`);
      }
    }),
  );
}

/**
 * Maps live printer state onto the job record.
 *
 * Deliberately conservative: it will mark a job finished or failed based on the
 * printer, but it never resurrects a job the user cancelled here.
 */
async function reconcileJob(printerId: string, status: PrinterStatus): Promise<void> {
  const job = await prisma.printJob.findFirst({
    where: {
      printerId,
      status: { in: [JobStatus.PRINTING, JobStatus.PAUSED, JobStatus.STARTING] },
    },
    orderBy: { queuedAt: 'desc' },
  });
  if (!job) return;

  const data: Record<string, unknown> = {};

  if (status.progress !== null) data.progress = status.progress;
  if (status.layerCurrent !== null) data.layerCurrent = status.layerCurrent;
  if (status.layerTotal !== null) data.layerTotal = status.layerTotal;
  if (status.etaSeconds !== null) data.etaSeconds = status.etaSeconds;

  switch (status.state) {
    case 'printing':
      data.status = JobStatus.PRINTING;
      break;
    case 'paused':
      data.status = JobStatus.PAUSED;
      break;
    case 'finished':
      data.status = JobStatus.DONE;
      data.progress = 100;
      data.finishedAt = new Date();
      break;
    case 'error':
      data.status = JobStatus.FAILED;
      data.error = status.message ?? 'The printer reported an error';
      data.finishedAt = new Date();
      break;
    case 'idle':
      // A printer that went idle while we thought it was printing either
      // finished quietly or was stopped at the panel. Treat a job that got most
      // of the way as done, anything else as cancelled — guessing "done" for a
      // print that died at 5% would be worse than guessing wrong here.
      if (job.status === JobStatus.PRINTING) {
        const nearlyDone = (job.progress ?? 0) >= 95;
        data.status = nearlyDone ? JobStatus.DONE : JobStatus.CANCELLED;
        data.finishedAt = new Date();
        if (!nearlyDone) data.error = 'Printer returned to idle before the print completed';
      }
      break;
    case 'offline':
      return; // transient; leave the job alone
  }

  if (Object.keys(data).length === 0) return;

  await prisma.printJob.update({ where: { id: job.id }, data });

  if (data.status && data.status !== job.status) {
    console.log(`[poll] job ${job.id} → ${String(data.status)}`);
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

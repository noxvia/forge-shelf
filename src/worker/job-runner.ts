import { JobStatus, type PrintJob, type Printer, type ModelFile } from '@prisma/client';
import { prisma } from '../lib/db';
import { absPath, safeName } from '../lib/storage';
import { adapterFor, connectionFor, canPrint, PrinterError } from '../lib/printers';

/**
 * Dispatches one queued print job: upload the file, then tell the printer to
 * start. Progress afterwards comes from the status poller, not from here.
 */
export async function runNextJob(): Promise<boolean> {
  const candidate = await prisma.printJob.findFirst({
    where: { status: JobStatus.QUEUED },
    orderBy: { queuedAt: 'asc' },
    select: { id: true, printerId: true },
  });
  if (!candidate) return false;

  // Never start a second job on a printer that's already committed.
  const busy = await prisma.printJob.findFirst({
    where: {
      printerId: candidate.printerId,
      status: { in: [JobStatus.UPLOADING, JobStatus.STARTING, JobStatus.PRINTING, JobStatus.PAUSED] },
    },
    select: { id: true },
  });
  if (busy) return false;

  const claim = await prisma.printJob.updateMany({
    where: { id: candidate.id, status: JobStatus.QUEUED },
    data: { status: JobStatus.UPLOADING, startedAt: new Date() },
  });
  if (claim.count === 0) return true;

  const job = await prisma.printJob.findUnique({
    where: { id: candidate.id },
    include: { printer: true, file: true },
  });
  if (!job) return true;

  try {
    await dispatch(job, job.printer, job.file);
    return true;
  } catch (err) {
    const message = describe(err);
    console.error(`[job] ${job.id} failed: ${message}`);

    await prisma.printJob.update({
      where: { id: job.id },
      data: { status: JobStatus.FAILED, error: message, finishedAt: new Date() },
    });
    await prisma.printer.update({
      where: { id: job.printerId },
      data: { lastError: message },
    });
    return true;
  }
}

async function dispatch(job: PrintJob, printer: Printer, file: ModelFile): Promise<void> {
  if (!canPrint(printer.kind, file.filename)) {
    throw new PrinterError(`${printer.name} cannot print ${file.filename}`);
  }

  const adapter = adapterFor(printer.kind);
  const target = connectionFor(printer);

  // Some firmwares choke on spaces and unicode in filenames on their own
  // storage, so normalise before it leaves here.
  const remoteName = safeName(file.filename).replace(/\s+/g, '_');
  const localPath = absPath(file.storagePath);

  console.log(`[job] ${job.id} uploading ${remoteName} to ${printer.name}`);

  let lastReport = 0;
  const upload = await adapter.upload(target, localPath, remoteName, (sent, total) => {
    // Upload progress maps onto the first 100% of the job's life; throttle DB
    // writes to once a second so a big file doesn't hammer Postgres.
    const now = Date.now();
    if (now - lastReport < 1000) return;
    lastReport = now;
    const pct = total > 0 ? Math.round((sent / total) * 100) : 0;
    void prisma.printJob
      .update({ where: { id: job.id }, data: { progress: pct } })
      .catch(() => {});
  });

  await prisma.printJob.update({
    where: { id: job.id },
    data: { status: JobStatus.STARTING, remoteFilename: upload.remoteFilename, progress: 0 },
  });

  console.log(`[job] ${job.id} starting print on ${printer.name}`);
  await adapter.start(target, upload);

  await prisma.printJob.update({
    where: { id: job.id },
    data: { status: JobStatus.PRINTING },
  });

  // Print counts are a library-level statistic, so bump it once per dispatch.
  if (job.modelId) {
    await prisma.model.update({
      where: { id: job.modelId },
      data: { printCount: { increment: 1 } },
    });
  }

  console.log(`[job] ${job.id} printing`);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

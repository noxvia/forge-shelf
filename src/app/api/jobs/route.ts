import { z } from 'zod';
import { FileKind } from '@prisma/client';
import { prisma } from '@/lib/db';
import { ok, handler, HttpError } from '@/lib/json';
import { canPrint, adapterFor } from '@/lib/printers';
import { ACTIVE_JOB_STATUSES } from '@/lib/jobs';
import { blockingIssues, type IssueReport } from '@/lib/slicer/issues';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const listQuery = z.object({
  status: z.enum(['active', 'finished', 'all']).default('all'),
  printerId: z.string().optional(),
  take: z.coerce.number().int().min(1).max(200).default(50),
});

export const GET = handler(async (req: Request) => {
  const parsed = listQuery.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) throw new HttpError(parsed.error.issues[0].message, 422);
  const { status, printerId, take } = parsed.data;

  const jobs = await prisma.printJob.findMany({
    where: {
      ...(printerId ? { printerId } : {}),
      ...(status === 'active'
        ? { status: { in: ACTIVE_JOB_STATUSES } }
        : status === 'finished'
          ? { status: { notIn: ACTIVE_JOB_STATUSES } }
          : {}),
    },
    orderBy: { queuedAt: 'desc' },
    take,
    include: {
      printer: { select: { id: true, name: true, kind: true, status: true } },
      file: { select: { id: true, filename: true, sizeBytes: true, meta: true } },
      model: { select: { id: true, name: true, slug: true } },
    },
  });

  return ok(jobs);
});

const createBody = z.object({
  printerId: z.string().min(1),
  fileId: z.string().min(1),
  /**
   * Send a file that risk detection flagged as dangerous. Explicit rather than
   * implicit: the caller has to say they've looked at it.
   */
  acknowledgeRisks: z.boolean().optional(),
});

/**
 * Queues a print. Validation happens here so the user gets an immediate, useful
 * error; the upload and start commands happen in the worker.
 */
export const POST = handler(async (req: Request) => {
  const parsed = createBody.safeParse(await req.json());
  if (!parsed.success) throw new HttpError(parsed.error.issues[0].message, 422);
  const { printerId, fileId, acknowledgeRisks } = parsed.data;

  const [printer, file] = await Promise.all([
    prisma.printer.findUnique({ where: { id: printerId } }),
    prisma.modelFile.findUnique({ where: { id: fileId } }),
  ]);

  if (!printer) throw new HttpError('Printer not found', 404);
  if (!file) throw new HttpError('File not found', 404);
  if (!printer.enabled) throw new HttpError(`${printer.name} is disabled`, 409);

  if (file.kind !== FileKind.SLICED) {
    throw new HttpError(
      `${file.filename} is not machine-ready. Slice it first, or upload a file your ` +
        `printer can read directly.`,
      422,
    );
  }

  if (!canPrint(printer.kind, file.filename)) {
    const accepts = adapterFor(printer.kind).accepts.join(', ');
    throw new HttpError(
      `${printer.name} cannot print ${file.filename}. It accepts: ${accepts}.`,
      422,
    );
  }

  // Refuse a file already known to carry a resin trap or suction cup unless the
  // caller says they've seen the report. Only blocks on findings we actually
  // have — an unchecked file is not treated as unsafe.
  if (!acknowledgeRisks) {
    const report = ((file.meta ?? {}) as { issues?: IssueReport }).issues;
    const blocking = report ? blockingIssues(report) : [];
    if (blocking.length > 0) {
      const what = [...new Set(blocking.map((b) => b.type))].join(' and ');
      const where = blocking
        .slice(0, 3)
        .map((b) => `${b.type} at layer ${b.layers}`)
        .join(', ');
      throw new HttpError(
        `${file.filename} has ${what} detected in it, which can leak uncured resin or tear ` +
          `the FEP (${where}). Review the report on the model page, then send it again to confirm.`,
        409,
      );
    }
  }

  // One job at a time per printer — these machines have no queue of their own,
  // and a second start command mid-print is how you ruin both prints.
  const busy = await prisma.printJob.findFirst({
    where: { printerId, status: { in: ACTIVE_JOB_STATUSES } },
    select: { id: true, status: true },
  });
  if (busy) {
    throw new HttpError(
      `${printer.name} already has a job ${busy.status.toLowerCase()}. Wait for it to ` +
        `finish or cancel it first.`,
      409,
    );
  }

  const job = await prisma.printJob.create({
    data: { printerId, fileId, modelId: file.modelId },
    include: {
      printer: { select: { id: true, name: true, kind: true } },
      file: { select: { id: true, filename: true, sizeBytes: true } },
      model: { select: { id: true, name: true } },
    },
  });

  return ok(job, { status: 202 });
});

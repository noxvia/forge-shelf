import { z } from 'zod';
import { JobStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { ok, handler, HttpError } from '@/lib/json';
import { adapterFor, connectionFor } from '@/lib/printers';
import { isActive } from '@/lib/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: { id: string } };

export const GET = handler(async (_req: Request, { params }: Ctx) => {
  const job = await prisma.printJob.findUnique({
    where: { id: params.id },
    include: {
      printer: { select: { id: true, name: true, kind: true, status: true } },
      file: { select: { id: true, filename: true, sizeBytes: true, meta: true } },
      model: { select: { id: true, name: true, slug: true } },
    },
  });
  if (!job) throw new HttpError('Job not found', 404);
  return ok(job);
});

const body = z.object({ action: z.enum(['pause', 'resume', 'cancel']) });

export const POST = handler(async (req: Request, { params }: Ctx) => {
  const parsed = body.safeParse(await req.json());
  if (!parsed.success) throw new HttpError(parsed.error.issues[0].message, 422);

  const job = await prisma.printJob.findUnique({
    where: { id: params.id },
    include: { printer: true },
  });
  if (!job) throw new HttpError('Job not found', 404);
  if (!isActive(job.status)) {
    throw new HttpError(`This job is already ${job.status.toLowerCase()}`, 409);
  }

  // A job still sitting in QUEUED has never reached the printer, so cancelling
  // it is purely a local matter.
  if (parsed.data.action === 'cancel' && job.status === JobStatus.QUEUED) {
    const updated = await prisma.printJob.update({
      where: { id: job.id },
      data: { status: JobStatus.CANCELLED, finishedAt: new Date() },
    });
    return ok(updated);
  }

  const adapter = adapterFor(job.printer.kind);
  const target = connectionFor(job.printer);

  try {
    switch (parsed.data.action) {
      case 'pause':
        await adapter.pause(target);
        await prisma.printJob.update({
          where: { id: job.id },
          data: { status: JobStatus.PAUSED },
        });
        break;
      case 'resume':
        await adapter.resume(target);
        await prisma.printJob.update({
          where: { id: job.id },
          data: { status: JobStatus.PRINTING },
        });
        break;
      case 'cancel':
        await adapter.cancel(target);
        await prisma.printJob.update({
          where: { id: job.id },
          data: { status: JobStatus.CANCELLED, finishedAt: new Date() },
        });
        break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new HttpError(`${job.printer.name} refused the command: ${message}`, 502);
  }

  const fresh = await prisma.printJob.findUnique({
    where: { id: job.id },
    include: { printer: { select: { id: true, name: true, kind: true } } },
  });
  return ok(fresh);
});

export const DELETE = handler(async (_req: Request, { params }: Ctx) => {
  const job = await prisma.printJob.findUnique({
    where: { id: params.id },
    select: { id: true, status: true },
  });
  if (!job) throw new HttpError('Job not found', 404);
  if (isActive(job.status)) {
    throw new HttpError('Cancel the job before removing it from history', 409);
  }

  await prisma.printJob.delete({ where: { id: job.id } });
  return ok({ deleted: job.id });
});

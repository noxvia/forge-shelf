import fsp from 'node:fs/promises';
import path from 'node:path';
import { FileKind, TaskStatus } from '@prisma/client';
import { prisma } from '../lib/db';
import { env } from '../lib/env';
import { absPath, sliceDirRelPath, safeName } from '../lib/storage';
import { adapterFor, SliceFailedError, SlicerUnavailableError } from '../lib/slicer';
import type { SliceOptions } from '../lib/slicer/options';

/** Keep the tail of a long slicer log; the head is rarely the interesting part. */
const LOG_LIMIT = 20_000;

/**
 * Picks up one queued slice and runs it to completion.
 * Returns true if it did work, so the loop can poll again immediately.
 */
export async function runNextSlice(): Promise<boolean> {
  // Claim atomically — updateMany with a status guard means two workers can
  // never grab the same task.
  const candidate = await prisma.sliceTask.findFirst({
    where: { status: TaskStatus.QUEUED },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!candidate) return false;

  const claim = await prisma.sliceTask.updateMany({
    where: { id: candidate.id, status: TaskStatus.QUEUED },
    data: { status: TaskStatus.RUNNING, startedAt: new Date() },
  });
  if (claim.count === 0) return true; // someone else took it; try again

  const task = await prisma.sliceTask.findUnique({
    where: { id: candidate.id },
    include: { inputFile: true, profile: true },
  });
  if (!task) return true;

  const label = `${task.inputFile.filename} → ${task.profile.name}`;
  console.log(`[slice] ${task.id} start: ${label}`);

  const workRel = sliceDirRelPath(task.id);
  const workDir = absPath(workRel);

  try {
    await fsp.mkdir(workDir, { recursive: true });

    const adapter = adapterFor(task.profile.technology);
    const logLines: string[] = [];

    const result = await adapter.slice({
      inputPath: absPath(task.inputFile.storagePath),
      workDir,
      profile: task.profile,
      options: (task.options ?? null) as SliceOptions | null,
      timeoutMs: env.sliceTimeoutMs,
      onLog: (line) => {
        logLines.push(line);
        if (logLines.length > 4000) logLines.splice(0, 1000);
      },
    });

    // Move the slicer's output to a stable name next to the model's other files.
    const baseName = task.inputFile.filename.replace(/\.[^.]+$/, '');
    const outName = safeName(`${baseName}.${task.profile.outputFormat}`);
    const finalRel = path.posix.join(workRel, outName);
    const finalAbs = absPath(finalRel);

    if (path.resolve(result.outputPath) !== finalAbs) {
      await fsp.rename(result.outputPath, finalAbs).catch(async () => {
        // rename fails across devices; fall back to a copy.
        await fsp.copyFile(result.outputPath, finalAbs);
        await fsp.rm(result.outputPath, { force: true });
      });
    }

    const stat = await fsp.stat(finalAbs);

    const outputFile = await prisma.modelFile.create({
      data: {
        modelId: task.inputFile.modelId,
        kind: FileKind.SLICED,
        technology: task.profile.technology,
        filename: outName,
        storagePath: finalRel,
        mime: 'application/octet-stream',
        sizeBytes: BigInt(stat.size),
        meta: {
          ...result.meta,
          slicedFrom: task.inputFile.filename,
          profile: task.profile.name,
        } as never,
      },
    });

    await prisma.sliceTask.update({
      where: { id: task.id },
      data: {
        status: TaskStatus.DONE,
        outputFileId: outputFile.id,
        finishedAt: new Date(),
        log: tail(result.log || logLines.join('\n')),
        error: null,
      },
    });

    console.log(`[slice] ${task.id} done: ${outName} (${stat.size} bytes)`);

    if (task.autoPrintPrinterId) {
      await queueAutoPrint(task.id, task.autoPrintPrinterId, outputFile.id, task.inputFile.modelId);
    }

    return true;
  } catch (err) {
    const message = describe(err);
    const log = err instanceof SliceFailedError ? err.log : '';

    await prisma.sliceTask.update({
      where: { id: task.id },
      data: {
        status: TaskStatus.FAILED,
        finishedAt: new Date(),
        error: message,
        log: tail(log),
      },
    });

    // A missing binary isn't a per-task problem; say so loudly once.
    if (err instanceof SlicerUnavailableError) console.error(`[slice] ${message}`);
    else console.error(`[slice] ${task.id} failed: ${message}`);

    return true;
  }
}

async function queueAutoPrint(
  taskId: string,
  printerId: string,
  fileId: string,
  modelId: string,
): Promise<void> {
  const printer = await prisma.printer.findUnique({
    where: { id: printerId },
    select: { id: true, name: true, enabled: true },
  });
  if (!printer?.enabled) {
    console.warn(`[slice] ${taskId} auto-print skipped: printer unavailable`);
    return;
  }

  const { ACTIVE_JOB_STATUSES } = await import('../lib/jobs');
  const busy = await prisma.printJob.findFirst({
    where: { printerId, status: { in: ACTIVE_JOB_STATUSES } },
    select: { id: true },
  });
  if (busy) {
    console.warn(`[slice] ${taskId} auto-print skipped: ${printer.name} is busy`);
    return;
  }

  await prisma.printJob.create({ data: { printerId, fileId, modelId } });
  console.log(`[slice] ${taskId} queued auto-print on ${printer.name}`);
}

function tail(log: string): string {
  if (log.length <= LOG_LIMIT) return log;
  return `…(truncated)…\n${log.slice(-LOG_LIMIT)}`;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

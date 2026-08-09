import fsp from 'node:fs/promises';
import path from 'node:path';
import { FileKind, TaskStatus, Technology } from '@prisma/client';
import { prisma } from '../lib/db';
import { env } from '../lib/env';
import { absPath, sliceDirRelPath, safeName } from '../lib/storage';
import { adapterFor, SliceFailedError, SlicerUnavailableError } from '../lib/slicer';
import type { SliceOptions } from '../lib/slicer/options';
import { bakePlate } from '../lib/slicer/plate';
import {
  checkPrintIssues,
  summariseIssues,
  blockingIssues,
  type IssueReport,
} from '../lib/slicer/issues';

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
    include: {
      inputFile: true,
      profile: true,
      plate: {
        include: {
          items: { include: { file: true }, orderBy: { createdAt: 'asc' } },
          printer: { select: { buildX: true, buildY: true, buildZ: true } },
        },
      },
    },
  });
  if (!task) return true;

  const sourceName = task.plate ? task.plate.name : (task.inputFile?.filename ?? 'unknown');
  console.log(`[slice] ${task.id} start: ${sourceName} → ${task.profile.name}`);

  const workRel = sliceDirRelPath(task.id);
  const workDir = absPath(workRel);

  try {
    await fsp.mkdir(workDir, { recursive: true });

    const adapter = adapterFor(task.profile.technology);
    const logLines: string[] = [];
    const onLog = (line: string) => {
      logLines.push(line);
      if (logLines.length > 4000) logLines.splice(0, 1000);
    };

    // A plate is many meshes with their own transforms; bake it down to one
    // before slicing, since the slicer's transform flags are global.
    let inputPath: string;
    let plateMeta: Record<string, unknown> = {};

    if (task.plate) {
      const bakedPath = path.join(workDir, 'plate.stl');
      const printer = task.plate.printer;
      const baked = await bakePlate(
        task.plate.items.map((i) => ({
          path: absPath(i.file.storagePath),
          posX: i.posX, posY: i.posY, posZ: i.posZ,
          rotX: i.rotX, rotY: i.rotY, rotZ: i.rotZ,
          scale: i.scale,
        })),
        bakedPath,
        {
          plate:
            printer?.buildX && printer.buildY && printer.buildZ
              ? { x: printer.buildX, y: printer.buildY, z: printer.buildZ }
              : null,
          workDir,
          onLog,
        },
      );

      if (!baked.ok) throw new Error(`Could not bake the plate: ${baked.error}`);
      if (baked.fits === false) {
        throw new Error(
          `The plate does not fit the printer's build volume — too large in ` +
            `${baked.exceeds?.join(' and ')}. Move or rescale the objects and try again.`,
        );
      }

      onLog(`[plate] baked ${baked.items} objects, ${baked.sizeMm?.join(' x ')} mm`);
      plateMeta = {
        plate: {
          id: task.plate.id,
          name: task.plate.name,
          items: baked.items,
          sizeMm: baked.sizeMm,
        },
      };
      inputPath = bakedPath;
    } else {
      if (!task.inputFile) throw new Error('Slice task has neither an input file nor a plate');
      inputPath = absPath(task.inputFile.storagePath);
    }

    const result = await adapter.slice({
      inputPath,
      workDir,
      profile: task.profile,
      options: (task.options ?? null) as SliceOptions | null,
      timeoutMs: env.sliceTimeoutMs,
      onLog,
    });

    // Move the slicer's output to a stable name next to the model's other files.
    const baseName = (task.plate?.name ?? task.inputFile?.filename ?? 'output').replace(
      /\.[^.]+$/,
      '',
    );
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

    // Risk detection runs before the task is marked done, so an auto-print
    // decision can never be made ahead of knowing whether the file is safe.
    let issues: IssueReport | null = null;
    if (env.issueCheckEnabled && task.profile.technology === Technology.SLA) {
      console.log(`[slice] ${task.id} checking for print risks`);
      issues = await checkPrintIssues(finalAbs);
      console.log(`[slice] ${task.id} risks: ${summariseIssues(issues)}`);
    }

    const outputFile = await prisma.modelFile.create({
      data: {
        // Plate output belongs to no single model, so it has no modelId and is
        // reached through the plate instead.
        modelId: task.inputFile?.modelId ?? null,
        kind: FileKind.SLICED,
        technology: task.profile.technology,
        filename: outName,
        storagePath: finalRel,
        mime: 'application/octet-stream',
        sizeBytes: BigInt(stat.size),
        meta: {
          ...result.meta,
          ...plateMeta,
          slicedFrom: task.plate?.name ?? task.inputFile?.filename,
          profile: task.profile.name,
          ...(issues ? { issues } : {}),
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
      await queueAutoPrint(
        task.id,
        task.autoPrintPrinterId,
        outputFile.id,
        task.inputFile?.modelId ?? null,
        issues,
      );
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
  modelId: string | null,
  issues: IssueReport | null,
): Promise<void> {
  // Never start an unattended print on a file with a resin trap or suction cup.
  // The user asked for auto-print on the assumption the slice would be fine;
  // silently printing something that can tear an FEP is not honouring that.
  const blocking = issues ? blockingIssues(issues) : [];
  if (blocking.length > 0) {
    const what = [...new Set(blocking.map((b) => b.type))].join(' and ');
    const reason =
      `Auto-print cancelled: risk detection found ${what} in the sliced file. ` +
      `Review it on the model page and print manually if you're happy with it.`;
    console.warn(`[slice] ${taskId} ${reason}`);
    await prisma.sliceTask.update({ where: { id: taskId }, data: { error: reason } });
    return;
  }

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

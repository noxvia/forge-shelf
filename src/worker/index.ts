import { TaskStatus } from '@prisma/client';
import { prisma } from '../lib/db';
import { env } from '../lib/env';
import { ensureStorage } from '../lib/storage';
import { runNextSlice } from './slice-runner';
import { runNextJob } from './job-runner';
import { pollPrinters } from './status-poller';

/**
 * The background process.
 *
 * Two independent loops:
 *   • work loop — drains the slice and print queues as fast as they fill
 *   • poll loop — refreshes printer status on a fixed cadence
 *
 * Queueing is done in Postgres rather than Redis: the volumes here are a handful
 * of tasks a day, and one fewer moving part is worth more than throughput.
 */

let shuttingDown = false;

async function workLoop(): Promise<void> {
  while (!shuttingDown) {
    let didWork = false;
    try {
      // Slicing first — a queued print may be waiting on its output.
      didWork = (await runNextSlice()) || (await runNextJob());
    } catch (err) {
      console.error('[worker] work loop error:', err);
    }
    // Back off only when idle, so a queue of ten slices runs back to back.
    if (!didWork) await sleep(env.workerPollMs);
  }
}

async function pollLoop(): Promise<void> {
  while (!shuttingDown) {
    try {
      await pollPrinters();
    } catch (err) {
      console.error('[worker] poll loop error:', err);
    }
    await sleep(env.printerPollMs);
  }
}

/**
 * A slice marked RUNNING with no process behind it can only be a task that was
 * interrupted by a restart. Fail those explicitly rather than leaving them to
 * sit forever.
 */
async function recoverInterrupted(): Promise<void> {
  const orphaned = await prisma.sliceTask.updateMany({
    where: { status: TaskStatus.RUNNING },
    data: {
      status: TaskStatus.FAILED,
      error: 'Interrupted by a worker restart. Queue it again to retry.',
      finishedAt: new Date(),
    },
  });
  if (orphaned.count > 0) {
    console.warn(`[worker] recovered ${orphaned.count} interrupted slice task(s)`);
  }

  // Jobs mid-upload are in the same boat; a half-sent file is not a print.
  const uploads = await prisma.printJob.updateMany({
    where: { status: 'UPLOADING' },
    data: {
      status: 'FAILED',
      error: 'Interrupted by a worker restart before the upload finished.',
      finishedAt: new Date(),
    },
  });
  if (uploads.count > 0) {
    console.warn(`[worker] recovered ${uploads.count} interrupted upload(s)`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  console.log('[worker] starting');
  await ensureStorage();
  await recoverInterrupted();

  const stop = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] ${signal} received, finishing current step`);
    // Give in-flight work a moment, then exit regardless.
    setTimeout(() => {
      void prisma.$disconnect().finally(() => process.exit(0));
    }, 2000).unref();
  };

  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  console.log(
    `[worker] running — queue poll ${env.workerPollMs}ms, printer poll ${env.printerPollMs}ms`,
  );

  await Promise.all([workLoop(), pollLoop()]);
}

main().catch((err) => {
  console.error('[worker] fatal:', err);
  process.exit(1);
});

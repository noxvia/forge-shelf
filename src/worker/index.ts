import { prisma } from '../lib/db';
import { env } from '../lib/env';
import { ensureStorage } from '../lib/storage';
import { runNextJob } from './job-runner';
import { pollPrinters } from './status-poller';

/**
 * The background process.
 *
 * Two independent loops:
 *   • work loop — dispatches queued print jobs
 *   • poll loop — refreshes printer status on a fixed cadence
 *
 * Queueing is done in Postgres rather than Redis: the volumes here are a handful
 * of jobs a day, and one fewer moving part is worth more than throughput.
 */

let shuttingDown = false;

async function workLoop(): Promise<void> {
  while (!shuttingDown) {
    let didWork = false;
    try {
      didWork = await runNextJob();
    } catch (err) {
      console.error('[worker] work loop error:', err);
    }
    // Back off only when idle, so a queue of jobs runs back to back.
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
 * A job left mid-upload by a restart is not a print — a half-sent file will
 * never start. Fail those explicitly rather than leaving them to sit.
 */
async function recoverInterrupted(): Promise<void> {
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

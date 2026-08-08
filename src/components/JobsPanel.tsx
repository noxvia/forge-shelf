'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { Loader2, Pause, Play, Square, Trash2, ListChecks } from 'lucide-react';
import { api, post, del, humanSize, humanDuration, relativeTime } from '@/lib/api-client';
import type { PrintJob, JobStatus } from '@/lib/types';

const ACTIVE: JobStatus[] = ['QUEUED', 'UPLOADING', 'STARTING', 'PRINTING', 'PAUSED'];

const STATUS_STYLES: Record<JobStatus, string> = {
  QUEUED: 'bg-muted/15 text-muted',
  UPLOADING: 'bg-accent2/15 text-accent2',
  STARTING: 'bg-accent2/15 text-accent2',
  PRINTING: 'bg-accent2/15 text-accent2',
  PAUSED: 'bg-warn/15 text-warn',
  DONE: 'bg-good/15 text-good',
  FAILED: 'bg-bad/15 text-bad',
  CANCELLED: 'bg-muted/15 text-muted',
};

export function JobsPanel() {
  const [jobs, setJobs] = useState<PrintJob[]>([]);
  const [filter, setFilter] = useState<'active' | 'finished' | 'all'>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setJobs(await api<PrintJob[]>(`/api/jobs?status=${filter}`));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load jobs');
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
    // Jobs move on their own as the worker polls printers.
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);

  const act = async (jobId: string, action: 'pause' | 'resume' | 'cancel') => {
    if (action === 'cancel' && !confirm('Cancel this print?')) return;
    setBusy(jobId);
    setError(null);
    try {
      await post(`/api/jobs/${jobId}`, { action });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Command failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Print jobs</h1>
        <div className="flex gap-1">
          {(['all', 'active', 'finished'] as const).map((f) => (
            <button
              key={f}
              type="button"
              className={clsx(filter === f ? 'btn-primary' : 'btn-secondary', 'capitalize')}
              onClick={() => setFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="rounded bg-bad/10 px-3 py-2 text-sm text-bad">{error}</p>}

      {loading && jobs.length === 0 && (
        <div className="grid place-items-center py-20 text-muted">
          <Loader2 size={22} className="animate-spin" />
        </div>
      )}

      {!loading && jobs.length === 0 && (
        <div className="card grid place-items-center py-16 text-center">
          <ListChecks size={28} className="mb-3 text-muted" />
          <p className="font-medium">No {filter === 'all' ? '' : filter} jobs</p>
          <p className="mt-1 text-sm text-muted">
            Send a print-ready file to a printer from any model&apos;s page.
          </p>
        </div>
      )}

      <div className="space-y-3">
        {jobs.map((job) => {
          const active = ACTIVE.includes(job.status);
          return (
            <div key={job.id} className="card p-4">
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={clsx(
                        'rounded px-2 py-0.5 text-xs font-medium',
                        STATUS_STYLES[job.status],
                      )}
                    >
                      {job.status.toLowerCase()}
                    </span>
                    {job.model ? (
                      <Link
                        href={`/models/${job.model.id}`}
                        className="truncate font-medium hover:text-accent"
                      >
                        {job.model.name}
                      </Link>
                    ) : (
                      <span className="font-medium">{job.file.filename}</span>
                    )}
                  </div>

                  <p className="mt-1 truncate text-xs text-muted">
                    {job.file.filename} · {humanSize(job.file.sizeBytes)} → {job.printer.name}
                  </p>

                  {active && (
                    <div className="mt-2">
                      <div className="h-1.5 overflow-hidden rounded-full bg-panel2">
                        <div
                          className="h-full bg-accent2 transition-all"
                          style={{ width: `${job.progress}%` }}
                        />
                      </div>
                      <p className="mt-1 text-xs text-muted">
                        {job.progress}%
                        {job.layerCurrent !== null && job.layerTotal !== null && (
                          <> · layer {job.layerCurrent}/{job.layerTotal}</>
                        )}
                        {job.etaSeconds !== null && <> · {humanDuration(job.etaSeconds)} left</>}
                      </p>
                    </div>
                  )}

                  {job.error && (
                    <p className="mt-2 rounded bg-bad/10 px-2 py-1.5 text-xs text-bad">
                      {job.error}
                    </p>
                  )}
                </div>

                <div className="flex shrink-0 flex-col items-end gap-2">
                  <span className="text-xs text-muted">
                    {relativeTime(job.finishedAt ?? job.startedAt ?? job.queuedAt)}
                  </span>

                  <div className="flex gap-1.5">
                    {job.status === 'PRINTING' && (
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => act(job.id, 'pause')}
                        disabled={busy === job.id}
                      >
                        <Pause size={13} />
                      </button>
                    )}
                    {job.status === 'PAUSED' && (
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => act(job.id, 'resume')}
                        disabled={busy === job.id}
                      >
                        <Play size={13} />
                      </button>
                    )}
                    {active && (
                      <button
                        type="button"
                        className="btn-danger"
                        onClick={() => act(job.id, 'cancel')}
                        disabled={busy === job.id}
                      >
                        {busy === job.id ? (
                          <Loader2 size={13} className="animate-spin" />
                        ) : (
                          <Square size={13} />
                        )}
                      </button>
                    )}
                    {!active && (
                      <button
                        type="button"
                        className="btn-ghost text-bad"
                        onClick={async () => {
                          await del(`/api/jobs/${job.id}`);
                          void load();
                        }}
                        title="Remove from history"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

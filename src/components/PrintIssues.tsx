'use client';

import { useState } from 'react';
import clsx from 'clsx';
import { ShieldCheck, ShieldAlert, ShieldQuestion, Loader2, ScanSearch } from 'lucide-react';
import { post } from '@/lib/api-client';

export interface PrintIssue {
  type: string;
  severity: 'danger' | 'warning' | 'info';
  layers: string;
  layerCount?: number;
  size?: string;
}

export interface IssueReport {
  ok: boolean;
  safe: boolean;
  total: number;
  counts: Record<string, number>;
  issues: PrintIssue[];
  error?: string;
  checkedAt: string;
}

/** What each finding actually means when the print is running. */
const EXPLAIN: Record<string, string> = {
  ResinTrap:
    'A sealed cavity holds liquid resin that never cures. It leaks later, and the trapped ' +
    'volume can pull against the FEP. Add drain holes or print solid.',
  SuctionCup:
    'A closed volume forms suction against the film on each peel. This is what tears FEP and ' +
    'rips models off supports.',
  Island:
    'Material appears with nothing beneath it. It will drop into the vat and can weld to the ' +
    'film. Usually means supports are missing.',
  Overhang: 'Steep unsupported angles. Often fine, but a common source of surface artefacts.',
  EmptyLayer: 'A layer with nothing in it — usually a slicing or model defect.',
  TouchingBound: 'Geometry reaches the edge of the build area; it may be clipped.',
  PrintHeight: 'The model exceeds the printer’s maximum height.',
};

export function PrintIssues({
  fileId,
  filename,
  report,
  onChecked,
}: {
  fileId: string;
  filename: string;
  report: IssueReport | null;
  onChecked: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const runCheck = async () => {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/files/${fileId}/issues`, {});
      onChecked();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Check failed');
    } finally {
      setBusy(false);
    }
  };

  const danger = report?.issues.filter((i) => i.severity === 'danger') ?? [];
  const status = !report
    ? 'unchecked'
    : report.error
      ? 'error'
      : danger.length > 0
        ? 'danger'
        : report.total > 0
          ? 'warning'
          : 'clean';

  const Icon =
    status === 'clean' ? ShieldCheck : status === 'unchecked' ? ShieldQuestion : ShieldAlert;

  return (
    <div
      className={clsx(
        'rounded border p-3',
        status === 'danger' && 'border-bad/40 bg-bad/5',
        status === 'warning' && 'border-warn/40 bg-warn/5',
        status === 'clean' && 'border-good/40 bg-good/5',
        (status === 'unchecked' || status === 'error') && 'border-edge',
      )}
    >
      <div className="flex items-start gap-2">
        <Icon
          size={16}
          className={clsx(
            'mt-0.5 shrink-0',
            status === 'danger' && 'text-bad',
            status === 'warning' && 'text-warn',
            status === 'clean' && 'text-good',
            (status === 'unchecked' || status === 'error') && 'text-muted',
          )}
        />

        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            {status === 'clean' && 'No print risks found'}
            {status === 'danger' && `Do not print unattended — ${danger.length} serious issue${danger.length === 1 ? '' : 's'}`}
            {status === 'warning' && `${report?.total} issue${report?.total === 1 ? '' : 's'} found`}
            {status === 'unchecked' && 'Not checked for print risks'}
            {status === 'error' && 'Risk detection did not run'}
          </p>

          {report && !report.error && report.total > 0 && (
            <p className="mt-0.5 text-xs text-muted">
              {Object.entries(report.counts)
                .map(([t, n]) => `${n} ${t}${n === 1 ? '' : 's'}`)
                .join(' · ')}
            </p>
          )}
          {report?.error && <p className="mt-0.5 text-xs text-muted">{report.error}</p>}

          {/* The dangerous ones get explained inline rather than hidden. */}
          {danger.length > 0 && (
            <ul className="mt-2 space-y-1.5">
              {[...new Set(danger.map((d) => d.type))].map((type) => (
                <li key={type} className="text-xs text-bad">
                  <span className="font-medium">{type}</span>
                  {' — '}
                  {EXPLAIN[type] ?? 'Likely to ruin the print.'}
                </li>
              ))}
            </ul>
          )}

          {report && report.total > 0 && (
            <>
              <button
                type="button"
                className="mt-2 text-xs text-muted underline hover:text-ink"
                onClick={() => setExpanded((e) => !e)}
              >
                {expanded ? 'Hide' : 'Show'} all {report.total}
              </button>
              {expanded && (
                <ul className="mt-2 max-h-52 space-y-0.5 overflow-auto font-mono text-[11px] text-muted">
                  {report.issues.map((i, n) => (
                    <li key={`${i.type}-${i.layers}-${n}`}>
                      <span
                        className={clsx(
                          i.severity === 'danger' && 'text-bad',
                          i.severity === 'warning' && 'text-warn',
                        )}
                      >
                        {i.type}
                      </span>{' '}
                      layer {i.layers}
                      {i.layerCount ? ` (${i.layerCount})` : ''} {i.size}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {error && <p className="mt-2 text-xs text-bad">{error}</p>}
        </div>

        <button
          type="button"
          className="btn-secondary shrink-0"
          onClick={runCheck}
          disabled={busy}
          title={`Analyse ${filename} for islands, resin traps and suction cups`}
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <ScanSearch size={13} />}
          {report ? 'Re-check' : 'Check'}
        </button>
      </div>
    </div>
  );
}

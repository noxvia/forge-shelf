import { env } from '../env';
import { run, exists } from './run';

/**
 * Post-slice risk detection, using UVtools' own analysis.
 *
 * This is the equivalent of ChiTuBox's Risk Detection, and it runs on the
 * sliced layers rather than the mesh — which is why it can see things a mesh
 * inspection cannot, like a cavity that only closes once the model is sliced.
 *
 * It matters most for hollowing: the app can warn that hollowing without drain
 * holes is dangerous, but only this can tell you whether a specific model
 * actually ended up with trapped resin.
 */

export type IssueType =
  | 'Island'
  | 'Overhang'
  | 'ResinTrap'
  | 'SuctionCup'
  | 'TouchingBound'
  | 'PrintHeight'
  | 'EmptyLayer'
  | 'Unknown';

export type IssueSeverity = 'danger' | 'warning' | 'info';

export interface PrintIssue {
  type: IssueType;
  severity: IssueSeverity;
  /** Layer number, or "180-299" for something spanning a range. */
  layers: string;
  /** How many layers it spans, when UVtools reports a range. */
  layerCount?: number;
  /** Raw size as reported: px² for area issues, px³ for volumes. */
  size?: string;
  raw: string;
}

export interface IssueReport {
  ok: boolean;
  /** True when nothing that could ruin a print was found. */
  safe: boolean;
  total: number;
  counts: Record<string, number>;
  issues: PrintIssue[];
  /** Set when detection could not run — missing binary, timeout, crash. */
  error?: string;
  checkedAt: string;
}

/**
 * How much each finding matters on a resin printer.
 *
 * ResinTrap and SuctionCup are 'danger' because they are the two that damage
 * hardware rather than just the print: trapped resin stays liquid inside a
 * sealed shell, and a suction cup can pull hard enough on the FEP to tear it.
 */
const SEVERITY: Record<IssueType, IssueSeverity> = {
  ResinTrap: 'danger',
  SuctionCup: 'danger',
  Island: 'warning',
  EmptyLayer: 'warning',
  PrintHeight: 'warning',
  TouchingBound: 'warning',
  Overhang: 'info',
  Unknown: 'info',
};

/** Normalises the label UVtools prints into our enum. */
function toType(label: string): IssueType {
  const key = label.trim().replace(/s$/, '');
  const known: IssueType[] = [
    'Island',
    'Overhang',
    'ResinTrap',
    'SuctionCup',
    'TouchingBound',
    'PrintHeight',
    'EmptyLayer',
  ];
  return known.find((k) => k.toLowerCase() === key.toLowerCase()) ?? 'Unknown';
}

/**
 * Parses UVtools' report. Lines look like:
 *
 *   Issues: 4
 *   Island, 140, 310001px², {X=4902,Y=2147,Width=563,Height=562}
 *   ResinTrap, 180-299  (120), 23615339px³, {X=5019,...}
 */
export function parseIssues(stdout: string): PrintIssue[] {
  const issues: PrintIssue[] = [];

  for (const line of stdout.split('\n')) {
    const text = line.trim();
    // Only lines that start with a known label and are comma-separated.
    const match = /^([A-Za-z]+),\s*([\d]+(?:-[\d]+)?)\s*(?:\((\d+)\))?\s*,\s*([^,]+)/.exec(text);
    if (!match) continue;

    const type = toType(match[1]);
    if (type === 'Unknown') continue;

    issues.push({
      type,
      severity: SEVERITY[type],
      layers: match[2],
      layerCount: match[3] ? Number(match[3]) : undefined,
      size: match[4]?.trim(),
      raw: text,
    });
  }

  return issues;
}

/**
 * Runs detection against a sliced file.
 *
 * Never throws: a failed check must not fail a slice that otherwise succeeded.
 * The report carries `error` instead, and `safe` stays false so nothing is
 * auto-printed on the strength of a check that did not actually run.
 */
export async function checkPrintIssues(
  filePath: string,
  opts: { timeoutMs?: number } = {},
): Promise<IssueReport> {
  const checkedAt = new Date().toISOString();
  const base: IssueReport = {
    ok: false,
    safe: false,
    total: 0,
    counts: {},
    issues: [],
    checkedAt,
  };

  const bin = env.uvtoolsBin;
  if (!(await exists(bin))) {
    return { ...base, error: `UVtools is not installed at ${bin}` };
  }

  let result;
  try {
    result = await run(
      bin,
      [
        '--no-progress',
        'print-issues',
        filePath,
        '-i', // islands
        '-o', // overhangs
        '-r', // resin traps
        '-s', // suction cups
        '-t', // touching bounds
        '-e', // empty layers
      ],
      { timeoutMs: opts.timeoutMs ?? env.issueCheckTimeoutMs, useXvfb: false },
    );
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }

  if (result.timedOut) {
    return {
      ...base,
      error:
        `Risk detection timed out after ${Math.round((opts.timeoutMs ?? env.issueCheckTimeoutMs) / 1000)}s. ` +
        `Large prints take longer — raise ISSUE_CHECK_TIMEOUT_SECONDS if this keeps happening.`,
    };
  }

  const issues = parseIssues(result.combined);
  const counts: Record<string, number> = {};
  for (const i of issues) counts[i.type] = (counts[i.type] ?? 0) + 1;

  return {
    ok: true,
    safe: !issues.some((i) => i.severity === 'danger'),
    total: issues.length,
    counts,
    issues: issues.slice(0, 200), // a pathological file can report thousands
    checkedAt,
  };
}

/** One-line summary for logs and the UI. */
export function summariseIssues(report: IssueReport): string {
  if (report.error) return `not checked (${report.error})`;
  if (report.total === 0) return 'no issues found';
  return Object.entries(report.counts)
    .map(([type, n]) => `${n} ${type}${n === 1 ? '' : 's'}`)
    .join(', ');
}

/** The findings that should stop an unattended print. */
export function blockingIssues(report: IssueReport): PrintIssue[] {
  return report.issues.filter((i) => i.severity === 'danger');
}

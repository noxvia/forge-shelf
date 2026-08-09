import path from 'node:path';
import { env } from '../env';
import { run, exists } from './run';

/**
 * Drain-hole drilling, as a mesh pre-processing step.
 *
 * PrusaSlicer only places drain holes through its GUI, so they are cut into the
 * mesh before it ever reaches the slicer. See src/tools/drill_drain_holes.py.
 *
 * Two measured caveats, both from UVtools resin-trap detection:
 *
 * 1. PrusaSlicer's default hollowing_closing_distance of 2mm closes the drilled
 *    opening back up while hollowing, sealing the resin in regardless. On a
 *    30mm cube at 2mm walls: no holes -> 2.93e9 px³ trapped; 2x4mm holes ->
 *    2.36e9 px³ still trapped; the same holes with closing distance 0 -> clean.
 *    DRAIN_HOLE_CLOSING_DISTANCE is therefore forced whenever holes are cut.
 *
 * 2. Drilling only works when the cavity is large relative to the wall. The
 *    hollowing offset applies to the hole's own surface too, so on a small model
 *    it pinches the cavity into disconnected pockets instead of draining it.
 *    Measured, 2mm walls, trap count after slicing:
 *
 *      30mm cube  no holes -> 1    2x3mm -> 0    2x4mm -> 0    1x5mm -> 0
 *      10mm cube  no holes -> 1    2x3mm -> 3    1x4mm -> 4    2x4mm -> 3
 *
 *    Every configuration cleared it at 30mm and none did at 10mm, so the
 *    determining factor is cavity size relative to wall, not hole geometry.
 *
 *    So this is not a guarantee, which is precisely why every resin slice is
 *    checked for trapped resin afterwards regardless of what was drilled.
 */

/** Hollowing must not re-close the hole we just cut. */
export const DRAIN_HOLE_CLOSING_DISTANCE = '0';

export interface DrillResult {
  ok: boolean;
  holes?: number;
  diameterMm?: number;
  positions?: [number, number][];
  volumeBefore?: number;
  volumeAfter?: number;
  watertight?: boolean;
  faces?: number;
  error?: string;
}

function scriptPath(): string {
  // Ships alongside the app source; overridable for local development where the
  // working directory differs.
  return process.env.DRILL_SCRIPT ?? path.join(process.cwd(), 'src', 'tools', 'drill_drain_holes.py');
}

export async function drainToolAvailable(): Promise<boolean> {
  return exists(scriptPath());
}

/**
 * Cuts `count` holes of `diameterMm` up through the underside of a mesh.
 * Resolves with ok:false and a reason rather than throwing, so a slice can
 * continue (unhollowed) instead of failing outright.
 */
export async function drillDrainHoles(
  inputPath: string,
  outputPath: string,
  count: number,
  diameterMm: number,
  opts: { timeoutMs?: number; onLog?: (line: string) => void } = {},
): Promise<DrillResult> {
  const script = scriptPath();
  if (!(await exists(script))) {
    return { ok: false, error: `Drain-hole tool not found at ${script}` };
  }

  let result;
  try {
    result = await run(
      env.pythonBin,
      [script, inputPath, outputPath, String(count), String(diameterMm)],
      { timeoutMs: opts.timeoutMs ?? env.drillTimeoutMs, onLog: opts.onLog, useXvfb: false },
    );
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error && /ENOENT/.test(err.message)
          ? `Python is not installed at ${env.pythonBin}, so drain holes cannot be drilled.`
          : err instanceof Error
            ? err.message
            : String(err),
    };
  }

  if (result.timedOut) {
    return { ok: false, error: 'Drilling drain holes timed out' };
  }

  // The script prints a single JSON object; find it even if libraries chattered.
  const line = result.combined
    .split('\n')
    .map((l) => l.trim())
    .reverse()
    .find((l) => l.startsWith('{') && l.endsWith('}'));

  if (!line) {
    return { ok: false, error: `Drain-hole tool produced no result (exit ${result.code})` };
  }

  try {
    return JSON.parse(line) as DrillResult;
  } catch {
    return { ok: false, error: 'Could not parse the drain-hole tool output' };
  }
}

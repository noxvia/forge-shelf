import fsp from 'node:fs/promises';
import path from 'node:path';
import { env } from '../env';
import { run, exists } from './run';

/**
 * Baking a build plate down to one mesh.
 *
 * Verified before this was built: three cubes at different scales, rotations and
 * positions bake into a single STL that PrusaSlicer reports as
 * number_of_parts = 3 and slices as one plate. The transform order lives in
 * src/tools/bake_plate.py and must match what the viewer does.
 */

export interface PlateItemSpec {
  path: string;
  /** Carried into the 3MF so objects are identifiable in the slicer. */
  name?: string;
  posX: number;
  posY: number;
  posZ: number;
  rotX: number;
  rotY: number;
  rotZ: number;
  scale: number;
}

export interface BakeResult {
  ok: boolean;
  items?: number;
  faces?: number;
  watertight?: boolean;
  boundsMin?: [number, number, number];
  boundsMax?: [number, number, number];
  sizeMm?: [number, number, number];
  triangles?: number;
  format?: string;
  /** Present when a build volume was supplied. */
  fits?: boolean;
  /** Which axes overflow, so the message can say which way it doesn't fit. */
  exceeds?: string[];
  error?: string;
}

function scriptPath(): string {
  return process.env.BAKE_SCRIPT ?? path.join(process.cwd(), 'src', 'tools', 'bake_plate.py');
}

export async function bakePlate(
  items: PlateItemSpec[],
  outputPath: string,
  opts: {
    format?: '3mf' | 'stl';
    plate?: { x: number; y: number; z: number } | null;
    workDir: string;
    timeoutMs?: number;
    onLog?: (line: string) => void;
  },
): Promise<BakeResult> {
  const script = scriptPath();
  if (!(await exists(script))) return { ok: false, error: `Plate bake tool not found at ${script}` };
  if (items.length === 0) return { ok: false, error: 'The plate is empty' };

  const specPath = path.join(opts.workDir, 'plate-spec.json');
  await fsp.writeFile(
    specPath,
    JSON.stringify({ output: outputPath, format: opts.format, plate: opts.plate ?? undefined, items }),
    'utf8',
  );

  let result;
  try {
    result = await run(env.pythonBin, [script, specPath], {
      cwd: opts.workDir,
      timeoutMs: opts.timeoutMs ?? env.meshTimeoutMs,
      onLog: opts.onLog,
      useXvfb: false,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  if (result.timedOut) return { ok: false, error: 'Baking the plate timed out' };

  const line = result.combined
    .split('\n')
    .map((l) => l.trim())
    .reverse()
    .find((l) => l.startsWith('{') && l.endsWith('}'));

  if (!line) return { ok: false, error: `Plate bake produced no result (exit ${result.code})` };

  try {
    return JSON.parse(line) as BakeResult;
  } catch {
    return { ok: false, error: 'Could not parse the plate bake output' };
  }
}

import { env } from '../env';
import { exists } from './run';

export interface ToolStatus {
  name: string;
  path: string;
  installed: boolean;
  purpose: string;
}

/**
 * What the container can actually do, for the diagnostics page.
 *
 * Slicing happens in your desktop slicer now; what remains are the helpers that
 * inspect and transform files. A missing one should read as "that feature is
 * unavailable", not as a mystery failure part-way through an operation.
 */
export async function toolStatus(): Promise<ToolStatus[]> {
  const python = await pythonAvailable();

  return [
    {
      name: 'UVtools',
      path: env.uvtoolsBin,
      installed: await exists(env.uvtoolsBin),
      purpose: 'Inspects sliced files for resin traps, islands and suction cups',
    },
    {
      name: 'Mesh tools',
      path: env.pythonBin,
      installed: python,
      purpose: 'Plate export, mesh inspection, repair and editing plugins',
    },
  ];
}

/** trimesh is the load-bearing import; a bare interpreter isn't enough. */
async function pythonAvailable(): Promise<boolean> {
  const { run } = await import('./run');
  try {
    const result = await run(env.pythonBin, ['-c', 'import trimesh, numpy'], {
      timeoutMs: 30_000,
      useXvfb: false,
    });
    return result.code === 0;
  } catch {
    return false;
  }
}

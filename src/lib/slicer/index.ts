import { Technology } from '@prisma/client';
import { orcaAdapter } from './fdm-orca';
import { slaAdapter } from './sla-prusa';
import { env } from '../env';
import { exists } from './run';
import type { SlicerAdapter } from './types';

export * from './types';
export { orcaAdapter, slaAdapter };

export function adapterFor(technology: Technology): SlicerAdapter {
  return technology === Technology.SLA ? slaAdapter : orcaAdapter;
}

export interface ToolStatus {
  name: string;
  path: string;
  installed: boolean;
  purpose: string;
}

/**
 * Powers the diagnostics panel. Slicer binaries are optional at build time, and
 * a missing one should read as "feature unavailable", not as a mystery failure
 * halfway through a slice.
 */
export async function toolStatus(): Promise<ToolStatus[]> {
  const tools = [
    {
      name: 'OrcaSlicer',
      path: env.orcaBin,
      purpose: 'Slices meshes to .gcode.3mf for Bambu Lab printers',
    },
    {
      name: 'PrusaSlicer',
      path: env.prusaBin,
      // Debian's package rather than an upstream AppImage — Prusa stopped
      // shipping those for Linux.
      purpose: 'Slices meshes to .sl1 in SLA mode for resin printers',
    },
    {
      name: 'UVtools',
      path: env.uvtoolsBin,
      purpose: 'Converts .sl1 to .ctb / .goo for ChiTu resin boards',
    },
  ];

  return Promise.all(
    tools.map(async (t) => ({ ...t, installed: await exists(t.path) })),
  );
}

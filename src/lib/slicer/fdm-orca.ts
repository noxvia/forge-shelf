import fsp from 'node:fs/promises';
import path from 'node:path';
import { env } from '../env';
import { run, exists, listFiles } from './run';
import {
  SliceFailedError,
  SlicerUnavailableError,
  type SliceRequest,
  type SliceResult,
  type SlicerAdapter,
} from './types';

/**
 * OrcaSlicer CLI adapter — produces the `.gcode.3mf` project files Bambu
 * printers expect.
 *
 * Orca's headless mode is genuinely headless for slicing but the binary still
 * links GTK, hence the xvfb wrapper in run(). Settings are written to disk as
 * the JSON bundles Orca expects; profiles that `inherits` a vendor preset
 * resolve against the AppImage's bundled resources.
 */
export const orcaAdapter: SlicerAdapter = {
  id: 'orca',

  binPath() {
    return env.orcaBin;
  },

  async available() {
    return exists(env.orcaBin);
  },

  async slice(req: SliceRequest): Promise<SliceResult> {
    const bin = env.orcaBin;
    if (!(await exists(bin))) throw new SlicerUnavailableError('OrcaSlicer', bin);

    const { profile, workDir, inputPath } = req;
    const outDir = path.join(workDir, 'out');
    const dataDir = path.join(workDir, 'orca-data');
    await fsp.mkdir(outDir, { recursive: true });
    await fsp.mkdir(dataDir, { recursive: true });

    // Write each config section Orca should load.
    const settingsFiles: string[] = [];
    for (const [name, content] of [
      ['machine.json', profile.machineConfig],
      ['process.json', profile.processConfig],
    ] as const) {
      if (!content?.trim()) continue;
      const p = path.join(workDir, name);
      await fsp.writeFile(p, content, 'utf8');
      settingsFiles.push(p);
    }

    const filamentFiles: string[] = [];
    if (profile.materialConfig?.trim()) {
      const p = path.join(workDir, 'filament.json');
      await fsp.writeFile(p, profile.materialConfig, 'utf8');
      filamentFiles.push(p);
    }

    const args: string[] = ['--datadir', dataDir];
    if (settingsFiles.length) args.push('--load-settings', settingsFiles.join(';'));
    if (filamentFiles.length) args.push('--load-filaments', filamentFiles.join(';'));

    args.push(
      '--orient', '1',       // drop the model flat on the plate
      '--arrange', '1',      // and centre it
      '--slice', '0',        // 0 = every plate
      '--export-3mf', path.join(outDir, 'print.gcode.3mf'),
      '--outputdir', outDir,
      ...extraArgs(profile.extraArgs),
      inputPath,
    );

    const result = await run(bin, args, {
      cwd: workDir,
      timeoutMs: req.timeoutMs,
      onLog: req.onLog,
      useXvfb: true,
    });

    if (result.timedOut) {
      throw new SliceFailedError(
        `OrcaSlicer timed out after ${Math.round(req.timeoutMs / 1000)}s`,
        result.combined,
      );
    }

    // Orca doesn't always honour --export-3mf's exact filename, so find whatever
    // machine-ready file it actually left behind.
    const produced = await findOutput(outDir);
    if (!produced) {
      throw new SliceFailedError(
        result.code === 0
          ? 'OrcaSlicer reported success but produced no output file'
          : `OrcaSlicer exited with code ${result.code}`,
        result.combined,
      );
    }

    return {
      outputPath: produced,
      outputName: path.basename(produced),
      log: result.combined,
      meta: scrapeMeta(result.combined),
    };
  },
};

async function findOutput(outDir: string): Promise<string | null> {
  const files = await listFiles(outDir);
  const ranked = files
    .filter((f) => /\.(gcode\.3mf|gcode|3mf)$/i.test(f))
    .sort((a, b) => rank(b) - rank(a));
  return ranked[0] ?? null;
}

function rank(f: string): number {
  if (/\.gcode\.3mf$/i.test(f)) return 3;
  if (/\.gcode$/i.test(f)) return 2;
  return 1;
}

function extraArgs(raw: string | null): string[] {
  return raw?.trim() ? raw.trim().split(/\s+/) : [];
}

/** Pull the numbers Orca prints so the UI can show time and filament use. */
function scrapeMeta(log: string): Record<string, unknown> {
  const meta: Record<string, unknown> = {};

  const time = /estimated printing time[^:]*:\s*([\dhms\s]+)/i.exec(log);
  if (time) meta.estimatedTime = time[1].trim();

  const grams = /filament used\s*\[g\]\s*=\s*([\d.]+)/i.exec(log);
  if (grams) meta.filamentGrams = Number(grams[1]);

  const mm = /filament used\s*\[mm\]\s*=\s*([\d.]+)/i.exec(log);
  if (mm) meta.filamentMm = Number(mm[1]);

  const layers = /total layer number:\s*(\d+)/i.exec(log);
  if (layers) meta.layerCount = Number(layers[1]);

  return meta;
}

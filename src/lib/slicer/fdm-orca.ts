import fsp from 'node:fs/promises';
import path from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
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

    const settingsFiles: string[] = [];
    for (const [name, content] of [
      ['machine', profile.machineConfig],
      ['process', profile.processConfig],
    ] as const) {
      const resolved = await resolveSetting(name, content, workDir);
      if (resolved) settingsFiles.push(resolved);
    }

    const filamentFiles: string[] = [];
    const filament = await resolveSetting('filament', profile.materialConfig, workDir);
    if (filament) filamentFiles.push(filament);

    const args: string[] = ['--datadir', dataDir];
    if (settingsFiles.length) args.push('--load-settings', settingsFiles.join(';'));
    if (filamentFiles.length) args.push('--load-filaments', filamentFiles.join(';'));

    args.push(
      '--orient', '1',       // drop the model flat on the plate
      '--arrange', '1',      // and centre it
      '--slice', '0',        // 0 = every plate
      // Must stay a bare filename: Orca joins --outputdir with this value, so an
      // absolute path here produces "/out//out/print.gcode.3mf" and the export
      // fails with the unhelpful "Failed exporting 3mf files."
      '--export-3mf', 'print.gcode.3mf',
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
      // Prefer the numbers inside the archive; fall back to the log for plain
      // .gcode output, which has no archive to read.
      meta: { ...scrapeMeta(result.combined), ...(await read3mfMeta(produced)) },
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

/** Where the AppImage keeps its bundled vendor presets. */
function presetRoot(): string {
  return path.join(path.dirname(env.orcaBin), 'resources', 'profiles');
}

/**
 * A profile section is either a preset name or a complete JSON config.
 *
 * Preset *names* are the useful case and the one that actually works: Orca's
 * own vendor files resolve their `inherits` chain against the bundled base
 * profiles. A hand-written stub that merely inherits a preset by name does not
 * — Orca loads it but then rejects the combination with "The selected printer
 * is not compatible with the process preset", because the compatibility
 * conditions match on printer identity that the stub doesn't carry.
 *
 * Inline JSON is still honoured for configs exported whole from the OrcaSlicer
 * GUI, which are flattened and self-contained.
 */
async function resolveSetting(
  kind: 'machine' | 'process' | 'filament',
  value: string | null,
  workDir: string,
): Promise<string | null> {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('{')) {
    const p = path.join(workDir, `${kind}.json`);
    await fsp.writeFile(p, trimmed, 'utf8');
    return p;
  }

  const found = await findPreset(kind, trimmed);
  if (!found) {
    throw new SliceFailedError(
      `OrcaSlicer has no ${kind} preset named "${trimmed}". Use the exact name as it ` +
        `appears in OrcaSlicer (for example "Bambu Lab X1 Carbon 0.4 nozzle"), or paste ` +
        `a full preset exported from the OrcaSlicer GUI instead.`,
      '',
    );
  }
  return found;
}

/** Searches every bundled vendor directory for <kind>/<name>.json. */
async function findPreset(kind: string, name: string): Promise<string | null> {
  const root = presetRoot();
  let vendors: string[];
  try {
    vendors = await fsp.readdir(root);
  } catch {
    return null;
  }

  const wanted = name.toLowerCase().replace(/\.json$/, '');
  for (const vendor of vendors) {
    const dir = path.join(root, vendor, kind);
    let entries: string[];
    try {
      entries = await fsp.readdir(dir);
    } catch {
      continue; // vendor.json and other non-directories
    }
    const hit = entries.find((e) => e.toLowerCase() === `${wanted}.json`);
    if (hit) return path.join(dir, hit);
  }
  return null;
}

/**
 * Reads Metadata/slice_info.config out of a .gcode.3mf.
 *
 * Far more reliable than scraping stdout, which prints none of this. Only that
 * one entry is decompressed — the sibling plate_N.gcode can be hundreds of
 * megabytes on a real print and there is no reason to inflate it.
 */
async function read3mfMeta(filePath: string): Promise<Record<string, unknown>> {
  if (!/\.3mf$/i.test(filePath)) return {};

  try {
    const buf = await fsp.readFile(filePath);
    const files = unzipSync(new Uint8Array(buf), {
      filter: (f) => /slice_info\.config$/i.test(f.name),
    });
    const key = Object.keys(files).find((k) => /slice_info\.config$/i.test(k));
    if (!key) return {};

    const xml = strFromU8(files[key]);
    const meta: Record<string, unknown> = {};

    const value = (k: string) =>
      new RegExp(`<metadata key="${k}" value="([^"]*)"`, 'i').exec(xml)?.[1];

    // "prediction" is the estimated print time in seconds. Note that
    // first_layer_time in the same file is routinely garbage (values around
    // 1e25), so it is deliberately not read.
    const prediction = Number(value('prediction'));
    if (Number.isFinite(prediction) && prediction > 0) meta.estimatedSeconds = prediction;

    const weight = Number(value('weight'));
    if (Number.isFinite(weight) && weight > 0) meta.filamentGrams = weight;

    const filament = /<filament\b[^>]*>/i.exec(xml)?.[0];
    if (filament) {
      const attr = (a: string) => new RegExp(`${a}="([^"]*)"`, 'i').exec(filament)?.[1];

      const grams = Number(attr('used_g'));
      if (Number.isFinite(grams) && grams > 0) meta.filamentGrams = grams;

      const metres = Number(attr('used_m'));
      if (Number.isFinite(metres) && metres > 0) meta.filamentMetres = metres;

      const type = attr('type');
      if (type) meta.filamentType = type;
    }

    // layer_ranges is an inclusive "first last" pair.
    const range = /layer_ranges="(\d+)\s+(\d+)"/i.exec(xml);
    if (range) meta.layerCount = Number(range[2]) - Number(range[1]) + 1;

    const nozzle = value('nozzle_diameters');
    if (nozzle) meta.nozzleDiameter = nozzle;

    if (value('support_used') === 'true') meta.supportsUsed = true;

    return meta;
  } catch (err) {
    console.warn('[orca] could not read slice_info.config:', err);
    return {};
  }
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

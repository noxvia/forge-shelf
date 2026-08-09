import fsp from 'node:fs/promises';
import path from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { env } from '../env';
import { run, exists, listFiles } from './run';
import { slaOptionArgs } from './options';
import { drillDrainHoles, DRAIN_HOLE_CLOSING_DISTANCE } from './drain';
import {
  SliceFailedError,
  SlicerUnavailableError,
  type SliceRequest,
  type SliceResult,
  type SlicerAdapter,
} from './types';

/**
 * Resin pipeline, in two hops:
 *
 *   1. PrusaSlicer slices the mesh in SLA mode to an .sl1 archive. PrusaSlicer
 *      is the only maintained open slicer with a real headless SLA CLI, but it
 *      only writes its own format.
 *   2. UVtools converts .sl1 to whatever the printer actually eats — .ctb for
 *      most Elegoo/Anycubic ChiTu boards, .goo for newer Elegoo firmware.
 *
 * If the profile's outputFormat is "sl1" the second hop is skipped.
 *
 * Caveat worth knowing: exposure settings live in the profile, and UVtools
 * carries them across verbatim. If prints come out over- or under-exposed, that
 * is the profile, not the conversion.
 */
export const slaAdapter: SlicerAdapter = {
  id: 'prusa-sla',

  binPath() {
    return env.prusaBin;
  },

  async available() {
    return exists(env.prusaBin);
  },

  async slice(req: SliceRequest): Promise<SliceResult> {
    const bin = env.prusaBin;
    if (!(await exists(bin))) throw new SlicerUnavailableError('PrusaSlicer', bin);

    const { profile, workDir, inputPath } = req;
    const outDir = path.join(workDir, 'out');
    await fsp.mkdir(outDir, { recursive: true });

    // PrusaSlicer takes a single flat ini; concatenate whatever the profile has.
    const iniPath = path.join(workDir, 'sla.ini');
    const ini = [profile.machineConfig, profile.processConfig, profile.materialConfig]
      .filter((s): s is string => Boolean(s?.trim()))
      .join('\n');
    if (!ini.trim()) {
      throw new SliceFailedError('SLA profile has no configuration', '');
    }
    await fsp.writeFile(iniPath, `${ini}\n`, 'utf8');

    const sl1Path = path.join(outDir, 'print.sl1');

    const log: string[] = [];
    const collect = (line: string) => {
      log.push(line);
      req.onLog?.(line);
    };

    // --- drain holes ---------------------------------------------------------
    // Cut into the mesh before slicing, because PrusaSlicer can only place them
    // from its GUI. Hollowing then has to be told not to close them again.
    let meshPath = inputPath;
    const drainMeta: Record<string, unknown> = {};
    const holes = req.options?.drainHoles;

    if (holes?.count) {
      const drilledPath = path.join(workDir, 'drilled.stl');
      collect(`[drain] cutting ${holes.count} x ${holes.diameterMm ?? 3}mm drain holes`);

      const drilled = await drillDrainHoles(
        inputPath,
        drilledPath,
        holes.count,
        holes.diameterMm ?? 3,
        { onLog: collect },
      );

      if (drilled.ok) {
        meshPath = drilledPath;
        drainMeta.drainHoles = {
          count: drilled.holes,
          diameterMm: drilled.diameterMm,
          positions: drilled.positions,
        };
        collect(`[drain] drilled ${drilled.holes} holes, mesh still watertight=${drilled.watertight}`);
      } else {
        // Not fatal: a model that cannot be drilled should still slice, but the
        // user must know they are getting a sealed shell.
        collect(`[drain] FAILED: ${drilled.error}`);
        drainMeta.drainHolesError = drilled.error;
      }
    }

    // Order matters: --load brings in the profile, then per-slice flags override
    // it, then the profile's own extraArgs get the last word.
    const sliceRun = await run(
      bin,
      [
        '--export-sla',
        '--load', iniPath,
        ...slaOptionArgs(req.options),
        // Must come after the option args so it wins: PrusaSlicer's default 2mm
        // closing distance seals drilled holes shut during hollowing, which
        // leaves the resin trapped despite the holes being there.
        ...(drainMeta.drainHoles
          ? ['--hollowing-closing-distance', DRAIN_HOLE_CLOSING_DISTANCE]
          : []),
        '--output', sl1Path,
        ...extraArgs(profile.extraArgs),
        meshPath,
      ],
      { cwd: workDir, timeoutMs: req.timeoutMs, onLog: collect, useXvfb: true },
    );

    if (sliceRun.timedOut) {
      throw new SliceFailedError(
        `PrusaSlicer timed out after ${Math.round(req.timeoutMs / 1000)}s`,
        log.join('\n'),
      );
    }

    const sl1 = (await exists(sl1Path))
      ? sl1Path
      : (await listFiles(outDir)).find((f) => /\.sl1s?$/i.test(f));

    if (!sl1) {
      throw new SliceFailedError(
        sliceRun.code === 0
          ? 'PrusaSlicer reported success but produced no .sl1 archive'
          : `PrusaSlicer exited with code ${sliceRun.code}`,
        log.join('\n'),
      );
    }

    const meta = { ...(await readSl1Meta(sl1)), ...drainMeta };
    const target = (profile.outputFormat || 'ctb').replace(/^\./, '').toLowerCase();

    if (target === 'sl1' || target === 'sl1s') {
      return { outputPath: sl1, outputName: path.basename(sl1), log: log.join('\n'), meta };
    }

    // --- hop 2: UVtools conversion -----------------------------------------
    const uv = env.uvtoolsBin;
    if (!(await exists(uv))) throw new SlicerUnavailableError('UVtools', uv);

    const convertedPath = path.join(outDir, `print.${target}`);
    // UVtools takes three arguments: input, target encoder, output. Passing a
    // bare extension fails for anything claimed by more than one encoder —
    // ".ctb" belongs to both Chitubox and CTBEncrypted — so ambiguous ones are
    // mapped to the strict encoder name UVtools asks for.
    const convertRun = await run(uv, ['convert', sl1, uvtoolsEncoder(target), convertedPath], {
      cwd: workDir,
      timeoutMs: req.timeoutMs,
      onLog: collect,
      useXvfb: false,
    });

    if (convertRun.timedOut) {
      throw new SliceFailedError(
        `UVtools conversion timed out after ${Math.round(req.timeoutMs / 1000)}s`,
        log.join('\n'),
      );
    }

    if (!(await exists(convertedPath))) {
      throw new SliceFailedError(
        `UVtools could not convert .sl1 to .${target} (exit ${convertRun.code}). ` +
          `Check that .${target} is a format UVtools supports for this printer.`,
        log.join('\n'),
      );
    }

    return {
      outputPath: convertedPath,
      outputName: path.basename(convertedPath),
      log: log.join('\n'),
      meta,
    };
  },
};

function extraArgs(raw: string | null): string[] {
  return raw?.trim() ? raw.trim().split(/\s+/) : [];
}

/**
 * Maps an output extension to the UVtools encoder that should produce it.
 *
 * Only extensions claimed by more than one encoder need this; UVtools resolves
 * the rest on its own and refuses the ambiguous ones outright with
 * "the extension is shared by multiple encoders, use the strict encoder name".
 * Anything unmapped is passed straight through, so a profile can name any
 * encoder UVtools supports without a change here.
 */
function uvtoolsEncoder(format: string): string {
  const AMBIGUOUS: Record<string, string> = {
    ctb: 'Chitubox',
    cbddlp: 'Chitubox',
    photon: 'Chitubox',
    'encrypted.ctb': 'CTBEncrypted',
  };
  return AMBIGUOUS[format.toLowerCase()] ?? format;
}

/**
 * An .sl1 is a zip whose config.ini holds exactly the numbers we want to show:
 * layer count, exposure, print time and resin volume. Far more reliable than
 * scraping stdout.
 */
async function readSl1Meta(sl1Path: string): Promise<Record<string, unknown>> {
  try {
    const buf = await fsp.readFile(sl1Path);
    const files = unzipSync(new Uint8Array(buf), {
      filter: (f) => /^(config|prusaslicer)\.ini$/i.test(f.name),
    });
    const key = Object.keys(files).find((k) => /config\.ini$/i.test(k));
    if (!key) return {};

    const cfg: Record<string, string> = {};
    for (const line of strFromU8(files[key]).split('\n')) {
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      cfg[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }

    const num = (k: string) => {
      const n = Number.parseFloat(cfg[k]);
      return Number.isFinite(n) ? n : undefined;
    };

    const fast = num('numFast') ?? 0;
    const slow = num('numSlow') ?? 0;

    return dropUndefined({
      layerCount: fast + slow || undefined,
      layerHeightMm: num('layerHeight'),
      exposureSeconds: num('expTime'),
      firstExposureSeconds: num('expTimeFirst'),
      estimatedSeconds: num('printTime'),
      resinMl: num('usedMaterial'),
      printerModel: cfg.printerModel,
      materialName: cfg.materialName,
    });
  } catch (err) {
    console.warn('[sla] could not read .sl1 metadata:', err);
    return {};
  }
}

function dropUndefined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ''));
}

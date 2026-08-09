import { z } from 'zod';

/**
 * Per-slice overrides, layered on top of a profile.
 *
 * These map onto PrusaSlicer CLI flags, which take precedence over the values
 * in the loaded .ini — so a profile stays the baseline and a single model can
 * deviate without cloning the whole profile.
 *
 * Deliberately a small set. Every SLA knob PrusaSlicer exposes is available by
 * editing the profile; these are the ones that genuinely differ model to model.
 */
export const sliceOptionsSchema = z.object({
  // --- geometry -----------------------------------------------------------
  /** Degrees about X. The usual "tilt it off the plate" angle for resin. */
  rotateX: z.number().min(-360).max(360).optional(),
  rotateY: z.number().min(-360).max(360).optional(),
  rotateZ: z.number().min(-360).max(360).optional(),
  /** 1 = unchanged. */
  scale: z.number().min(0.01).max(100).optional(),

  // --- hollowing ----------------------------------------------------------
  hollow: z.boolean().optional(),
  /** Wall thickness in mm. Below ~1.5mm most resins get fragile. */
  hollowThicknessMm: z.number().min(0.4).max(10).optional(),
  /** 0–1; higher is a closer fit to the surface and slower. */
  hollowQuality: z.number().min(0).max(1).optional(),

  /**
   * Drain holes cut into the mesh before slicing, since PrusaSlicer can only
   * place them from its GUI. Without these a hollowed model traps resin.
   */
  drainHoles: z
    .object({
      count: z.number().int().min(1).max(12),
      /** 3–4mm is the usual range; smaller drains too slowly to matter. */
      diameterMm: z.number().min(1).max(15).optional(),
    })
    .optional(),

  // --- supports -----------------------------------------------------------
  supports: z.boolean().optional(),
  /** "default" is PrusaSlicer's pillar style; "branching" is tree-like. */
  supportTreeType: z.enum(['default', 'branching']).optional(),
  /** Height the model is lifted above the pad, mm. */
  supportElevationMm: z.number().min(0).max(50).optional(),
  /** Contact point diameter, mm. Smaller marks less but holds less. */
  supportHeadDiameterMm: z.number().min(0.1).max(2).optional(),
  /** Only grow supports from the build plate, never off the model. */
  supportsBuildplateOnly: z.boolean().optional(),

  // --- pad ----------------------------------------------------------------
  pad: z.boolean().optional(),
  /** Pad hugs the object instead of sitting under elevated supports. */
  padAroundObject: z.boolean().optional(),

  // --- exposure -----------------------------------------------------------
  exposureSeconds: z.number().min(0.1).max(200).optional(),
  firstExposureSeconds: z.number().min(0.1).max(400).optional(),
  layerHeightMm: z.number().min(0.01).max(0.3).optional(),
});

export type SliceOptions = z.infer<typeof sliceOptionsSchema>;

/**
 * Translates options into PrusaSlicer CLI arguments.
 *
 * Booleans are explicit in both directions — PrusaSlicer accepts --foo and
 * --no-foo — so switching something off in the UI actually overrides a profile
 * that switches it on.
 */
export function slaOptionArgs(options: SliceOptions | null | undefined): string[] {
  if (!options) return [];
  const args: string[] = [];
  const num = (v: number) => String(v);

  if (options.rotateX !== undefined) args.push('--rotate-x', num(options.rotateX));
  if (options.rotateY !== undefined) args.push('--rotate-y', num(options.rotateY));
  if (options.rotateZ !== undefined) args.push('--rotate', num(options.rotateZ));
  if (options.scale !== undefined) args.push('--scale', num(options.scale));

  if (options.hollow !== undefined) {
    args.push(options.hollow ? '--hollowing-enable' : '--no-hollowing-enable');
  }
  if (options.hollowThicknessMm !== undefined) {
    args.push('--hollowing-min-thickness', num(options.hollowThicknessMm));
  }
  if (options.hollowQuality !== undefined) {
    args.push('--hollowing-quality', num(options.hollowQuality));
  }

  if (options.supports !== undefined) {
    args.push(options.supports ? '--supports-enable' : '--no-supports-enable');
  }
  if (options.supportTreeType) args.push('--support-tree-type', options.supportTreeType);
  if (options.supportElevationMm !== undefined) {
    args.push('--support-object-elevation', num(options.supportElevationMm));
  }
  if (options.supportHeadDiameterMm !== undefined) {
    args.push('--support-head-front-diameter', num(options.supportHeadDiameterMm));
  }
  if (options.supportsBuildplateOnly !== undefined) {
    args.push(
      options.supportsBuildplateOnly ? '--support-buildplate-only' : '--no-support-buildplate-only',
    );
  }

  if (options.pad !== undefined) {
    args.push(options.pad ? '--pad-enable' : '--no-pad-enable');
  }
  if (options.padAroundObject !== undefined) {
    args.push(options.padAroundObject ? '--pad-around-object' : '--no-pad-around-object');
  }

  if (options.exposureSeconds !== undefined) {
    args.push('--exposure-time', num(options.exposureSeconds));
  }
  if (options.firstExposureSeconds !== undefined) {
    args.push('--initial-exposure-time', num(options.firstExposureSeconds));
  }
  if (options.layerHeightMm !== undefined) args.push('--layer-height', num(options.layerHeightMm));

  return args;
}

/**
 * Warnings worth showing before a slice runs. These are print-safety issues,
 * not validation errors — the slice will succeed either way.
 */
export function slaOptionWarnings(options: SliceOptions | null | undefined): string[] {
  if (!options) return [];
  const warnings: string[] = [];

  if (options.hollow && !options.drainHoles?.count) {
    warnings.push(
      'Hollowing is on with no drain holes, so the model will be a sealed shell holding ' +
        'uncured resin — it can form a suction cup against the FEP and burst. Set drain ' +
        'holes below, or print solid. The sliced file is checked for trapped resin either way.',
    );
  }
  if (options.drainHoles?.count && !options.hollow) {
    warnings.push(
      'Drain holes are set but hollowing is off, so the holes will just be holes through a ' +
        'solid model. Turn hollowing on if you meant to save resin.',
    );
  }
  if (options.drainHoles && (options.drainHoles.diameterMm ?? 3) < 2) {
    warnings.push(
      `A ${options.drainHoles.diameterMm}mm drain hole is small enough that resin drains ` +
        `very slowly and can bridge over during printing. 3–4mm is the usual range.`,
    );
  }
  if (options.supports === false && options.pad === false) {
    warnings.push(
      'Supports and pad are both off. This only works for a model that sits flat on the ' +
        'plate with no overhangs.',
    );
  }
  if (options.hollowThicknessMm !== undefined && options.hollowThicknessMm < 1.5) {
    warnings.push(
      `A ${options.hollowThicknessMm}mm wall is thin for most resins and is prone to ` +
        `cracking or warping. 2mm is a common floor.`,
    );
  }

  return warnings;
}

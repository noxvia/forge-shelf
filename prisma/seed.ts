/**
 * Idempotent seed. Runs on every container start; only fills in what's missing.
 *
 * The slicer profiles here are deliberately conservative starting points. The
 * SLA profiles are complete and self-contained (PrusaSlicer has no vendor
 * presets for Elegoo/Anycubic hardware, so every relevant value is spelled
 * out). The FDM profile inherits from OrcaSlicer's bundled Bambu system preset,
 * which is the only sane way to get Bambu machine limits right â€” check
 * Settings â†’ Profiles in the UI and paste an exported Orca profile if you want
 * something tuned.
 */
import { PrismaClient, Technology, PrinterKind } from '@prisma/client';

const prisma = new PrismaClient();

const MARS4_ULTRA_INI = `
# PrusaSlicer SLA config â€” Elegoo Mars 4 Ultra (9K mono, 7 inch)
printer_technology = SLA
printer_model = MARS4U

display_width = 153.36
display_height = 77.76
display_pixels_x = 8520
display_pixels_y = 4320
display_orientation = landscape
display_mirror_x = 1
display_mirror_y = 0
max_print_height = 165

layer_height = 0.05
initial_layer_height = 0.05
faded_layers = 6

exposure_time = 2.5
initial_exposure_time = 30

elefant_foot_compensation = 0.2
elefant_foot_min_width = 0.2
absolute_correction = 0
gamma_correction = 1

supports_enable = 1
support_head_front_diameter = 0.4
support_head_penetration = 0.2
support_head_width = 1
support_pillar_diameter = 1
support_pillar_connection_mode = dynamic
support_base_diameter = 3
support_base_height = 1
support_object_elevation = 5
pad_enable = 1
pad_wall_thickness = 2
pad_wall_height = 0
pad_brim_size = 1.6

hollowing_enable = 0
`.trim();

const SATURN4_ULTRA_INI = `
# PrusaSlicer SLA config â€” Elegoo Saturn 4 Ultra (12K mono, 10 inch)
printer_technology = SLA
printer_model = SAT4U

display_width = 218.88
display_height = 122.88
display_pixels_x = 11520
display_pixels_y = 5120
display_orientation = landscape
display_mirror_x = 1
display_mirror_y = 0
max_print_height = 220

layer_height = 0.05
initial_layer_height = 0.05
faded_layers = 6

exposure_time = 2.2
initial_exposure_time = 25

elefant_foot_compensation = 0.2
absolute_correction = 0
gamma_correction = 1

supports_enable = 1
support_head_front_diameter = 0.4
support_head_penetration = 0.2
support_head_width = 1
support_pillar_diameter = 1
support_pillar_connection_mode = dynamic
support_base_diameter = 3
support_base_height = 1
support_object_elevation = 5
pad_enable = 1
pad_wall_thickness = 2
pad_brim_size = 1.6

hollowing_enable = 0
`.trim();

/**
 * FDM profiles name OrcaSlicer presets rather than embedding JSON.
 *
 * A hand-written stub that just `inherits` a vendor preset does not work: Orca
 * loads it and then refuses the combination with "The selected printer is not
 * compatible with the process preset", because compatibility is matched on
 * printer identity the stub doesn't carry. Naming the preset makes the adapter
 * hand Orca its own vendor file, whose inherit chain resolves properly.
 *
 * Names must match OrcaSlicer exactly. To customise, export a full preset from
 * the OrcaSlicer GUI and paste that JSON in instead — the adapter accepts
 * either form.
 */
const ORCA_MACHINE_X1C = 'Bambu Lab X1 Carbon 0.4 nozzle';
const ORCA_PROCESS_020 = '0.20mm Standard @BBL X1C';
const ORCA_FILAMENT_PLA = 'Bambu PLA Basic @BBL X1C';

const profiles = [
  {
    name: 'Bambu X1C â€” 0.20mm Standard PLA',
    technology: Technology.FDM,
    printerKind: PrinterKind.FDM_BAMBU,
    description:
      "OrcaSlicer using Bambu's bundled X1C 0.4 nozzle presets at 0.20mm. Edit or " +
      'replace with a preset exported from the OrcaSlicer GUI to customise.',
    machineConfig: ORCA_MACHINE_X1C,
    processConfig: ORCA_PROCESS_020,
    materialConfig: ORCA_FILAMENT_PLA,
    outputFormat: 'gcode.3mf',
    extraArgs: null,
    isDefault: true,
  },
  {
    name: 'Elegoo Mars 4 Ultra â€” 50Âµm',
    technology: Technology.SLA,
    printerKind: PrinterKind.RESIN_SDCP,
    description:
      'PrusaSlicer SLA at 50Âµm with auto supports and a pad, converted to .ctb by UVtools.',
    machineConfig: MARS4_ULTRA_INI,
    processConfig: null,
    materialConfig: null,
    outputFormat: 'ctb',
    extraArgs: null,
    isDefault: true,
  },
  {
    name: 'Elegoo Saturn 4 Ultra â€” 50Âµm',
    technology: Technology.SLA,
    printerKind: PrinterKind.RESIN_SDCP,
    description: 'PrusaSlicer SLA at 50Âµm for the 12K 10" panel, converted to .ctb by UVtools.',
    machineConfig: SATURN4_ULTRA_INI,
    processConfig: null,
    materialConfig: null,
    outputFormat: 'ctb',
    extraArgs: null,
    isDefault: false,
  },
];

const tags = [
  { name: 'Miniature', slug: 'miniature', color: '#f0883e' },
  { name: 'Functional', slug: 'functional', color: '#58a6ff' },
  { name: 'Terrain', slug: 'terrain', color: '#3fb950' },
  { name: 'Cosplay', slug: 'cosplay', color: '#bc8cff' },
  { name: 'Spare part', slug: 'spare-part', color: '#d29922' },
  { name: 'Needs supports', slug: 'needs-supports', color: '#f85149' },
];

async function main() {
  for (const p of profiles) {
    await prisma.slicerProfile.upsert({
      where: { name: p.name },
      update: {}, // never clobber a profile the user has edited
      create: p,
    });
  }

  for (const t of tags) {
    await prisma.tag.upsert({ where: { slug: t.slug }, update: {}, create: t });
  }

  const [profileCount, tagCount] = await Promise.all([
    prisma.slicerProfile.count(),
    prisma.tag.count(),
  ]);
  console.log(`[seed] ${profileCount} slicer profiles, ${tagCount} tags`);
}

main()
  .catch((e) => {
    console.error('[seed] failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

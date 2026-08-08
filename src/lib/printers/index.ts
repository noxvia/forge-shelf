import { PrinterKind, Technology, type Printer } from '@prisma/client';
import { decryptSecret } from '../crypto';
import { bambuAdapter } from './bambu';
import { sdcpAdapter } from './sdcp';
import { PrinterError, targetFor, type PrinterAdapter, type PrinterTarget } from './types';

export * from './types';
export { discoverAll, discoverSdcp, discoverBambu, type Discovered } from './discovery';

const ADAPTERS: Record<PrinterKind, PrinterAdapter> = {
  [PrinterKind.FDM_BAMBU]: bambuAdapter,
  [PrinterKind.RESIN_SDCP]: sdcpAdapter,
};

export function adapterFor(kind: PrinterKind): PrinterAdapter {
  const a = ADAPTERS[kind];
  if (!a) throw new PrinterError(`No adapter for printer kind ${kind}`);
  return a;
}

export function technologyFor(kind: PrinterKind): Technology {
  return kind === PrinterKind.RESIN_SDCP ? Technology.SLA : Technology.FDM;
}

/** Decrypts the stored access code and builds the connection target. */
export function connectionFor(printer: Printer): PrinterTarget {
  let secret: string | null = null;
  if (printer.secretEnc) {
    try {
      secret = decryptSecret(printer.secretEnc);
    } catch {
      throw new PrinterError(
        `Could not decrypt the access code for ${printer.name}. This happens when ` +
          `APP_SECRET changed — re-enter the code in the printer's settings.`,
      );
    }
  }
  return targetFor(printer, secret);
}

/**
 * Whether a given sliced file can go to a given printer. Prevents the obvious
 * catastrophe of sending resin layer data to an FDM machine.
 */
export function canPrint(kind: PrinterKind, filename: string): boolean {
  const lower = filename.toLowerCase();
  return adapterFor(kind).accepts.some((ext) => lower.endsWith(`.${ext}`));
}

export const PRINTER_KIND_LABELS: Record<PrinterKind, string> = {
  [PrinterKind.FDM_BAMBU]: 'Bambu Lab (LAN)',
  [PrinterKind.RESIN_SDCP]: 'Resin — SDCP',
};

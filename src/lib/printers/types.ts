import type { Printer } from '@prisma/client';

export type PrinterState = 'idle' | 'printing' | 'paused' | 'finished' | 'error' | 'offline';

export interface PrinterStatus {
  state: PrinterState;
  /** 0–100, or null when the printer doesn't report it. */
  progress: number | null;
  layerCurrent: number | null;
  layerTotal: number | null;
  /** Seconds remaining, when known. */
  etaSeconds: number | null;
  /** Whatever is currently on the plate. */
  jobName: string | null;
  nozzleTemp?: number | null;
  bedTemp?: number | null;
  chamberTemp?: number | null;
  /** UV LED / vat temperature on resin machines. */
  uvLedTemp?: number | null;
  message?: string | null;
  /** Untouched adapter payload, shown in the printer detail drawer. */
  raw?: unknown;
}

export interface UploadResult {
  /** Name of the file as it now exists on the printer. */
  remoteFilename: string;
  /** Path the start command should reference, if the protocol needs one. */
  remotePath: string;
}

/**
 * Connection details, with the access code already decrypted. Adapters are
 * stateless: every call opens a connection, does one thing, and closes.
 */
export interface PrinterTarget {
  host: string;
  port: number | null;
  serial: string | null;
  secret: string | null;
  name: string;
}

export interface PrinterAdapter {
  readonly kind: string;
  /** File extensions this printer can print, lowercase, without the dot. */
  readonly accepts: string[];

  status(target: PrinterTarget): Promise<PrinterStatus>;

  upload(
    target: PrinterTarget,
    localPath: string,
    remoteName: string,
    onProgress?: (sentBytes: number, totalBytes: number) => void,
  ): Promise<UploadResult>;

  start(target: PrinterTarget, upload: UploadResult): Promise<void>;

  pause(target: PrinterTarget): Promise<void>;
  resume(target: PrinterTarget): Promise<void>;
  cancel(target: PrinterTarget): Promise<void>;
}

export function targetFor(printer: Printer, secret: string | null): PrinterTarget {
  return {
    host: printer.host,
    port: printer.port,
    serial: printer.serial,
    secret,
    name: printer.name,
  };
}

export class PrinterError extends Error {
  constructor(
    message: string,
    readonly retriable = false,
  ) {
    super(message);
  }
}

/** Uniform timeout wrapper — no adapter call should hang a worker loop forever. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new PrinterError(`${what} timed out after ${ms}ms`, true)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

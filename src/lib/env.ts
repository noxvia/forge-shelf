/**
 * Environment access in one place. Read lazily so the Next build doesn't need a
 * populated environment, and so the worker and web process agree on defaults.
 */

function str(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable ${name}`);
  }
  return v;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const env = {
  get storageDir() {
    return str('STORAGE_DIR', './data');
  },
  get appSecret() {
    return str('APP_SECRET');
  },
  get maxUploadBytes() {
    return int('MAX_UPLOAD_MB', 2048) * 1024 * 1024;
  },

  // Slicer binaries
  get orcaBin() {
    return str('ORCA_BIN', '/opt/orca/AppRun');
  },
  get prusaBin() {
    return str('PRUSA_BIN', '/usr/bin/prusa-slicer');
  },
  get uvtoolsBin() {
    return str('UVTOOLS_BIN', '/opt/uvtools/usr/bin/UVtoolsCmd');
  },
  get sliceTimeoutMs() {
    return int('SLICE_TIMEOUT_SECONDS', 900) * 1000;
  },

  // Worker cadence
  get workerPollMs() {
    return int('WORKER_POLL_MS', 3000);
  },
  get printerPollMs() {
    return int('PRINTER_POLL_MS', 10_000);
  },

  get sdcpBroadcast() {
    return str('SDCP_BROADCAST', '255.255.255.255');
  },
};

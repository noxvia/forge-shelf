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

  /** UVtools — inspects sliced files for resin traps, islands, suction cups. */
  get uvtoolsBin() {
    return str('UVTOOLS_BIN', '/opt/uvtools/usr/bin/UVtoolsCmd');
  },

  /**
   * Where STORAGE_DIR appears on the *host*, when the volume is a bind mount.
   *
   * The container sees /data; a desktop slicer on the same machine needs the
   * real path. Without this the "open in" buttons can't be offered, so they
   * hide themselves rather than producing a path that doesn't resolve.
   */
  get hostDataDir(): string | null {
    return process.env.HOST_DATA_DIR?.trim() || null;
  },
  /** Post-slice risk detection. Scales with layer count, so give it room. */
  get issueCheckTimeoutMs() {
    return int('ISSUE_CHECK_TIMEOUT_SECONDS', 600) * 1000;
  },
  /** Set false to skip risk detection entirely. */
  get issueCheckEnabled() {
    return (process.env.ISSUE_CHECK ?? 'true').toLowerCase() !== 'false';
  },
  /** Interpreter that runs plate export, mesh tools and plugins. */
  get pythonBin() {
    return str('PYTHON_BIN', 'python3');
  },
  /** Ceiling on a single mesh operation. */
  get meshTimeoutMs() {
    return int('MESH_TIMEOUT_SECONDS', 300) * 1000;
  },
  /** Where editing plugins are discovered. Mounted, so they need no rebuild. */
  get pluginsDir() {
    return str('PLUGINS_DIR', '/data/plugins');
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

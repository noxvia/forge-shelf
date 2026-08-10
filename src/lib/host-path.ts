import path from 'node:path';
import { env } from './env';

/**
 * Translates a stored path into the path a desktop application on the same
 * machine would use.
 *
 * The container sees STORAGE_DIR (/data); the host sees whatever the bind mount
 * points at. HOST_DATA_DIR carries that, and the mapping is a simple prefix
 * swap because the two always describe the same directory.
 *
 * Returns null when HOST_DATA_DIR isn't configured — the caller should then
 * hide "open in" affordances rather than hand out a path that won't resolve.
 */
export function toHostPath(storagePath: string): string | null {
  const root = env.hostDataDir;
  if (!root) return null;

  // Stored paths are POSIX-relative to STORAGE_DIR, e.g. "models/<id>/<file>".
  const relative = storagePath.replace(/^[\\/]+/, '');
  const windows = /^[a-zA-Z]:[\\/]/.test(root) || root.startsWith('\\\\');

  if (windows) {
    const joined = `${root.replace(/[\\/]+$/, '')}\\${relative.replace(/\//g, '\\')}`;
    return joined;
  }
  return path.posix.join(root.replace(/\/+$/, ''), relative);
}

/**
 * Builds the URL our protocol handler responds to.
 *
 * The app key is a name the handler resolves against an allowlist built at
 * install time — deliberately not an executable path, since any web page can
 * invoke a registered scheme.
 */
export function openInUri(app: string, hostPath: string): string {
  return `forgeshelf://open?app=${encodeURIComponent(app)}&path=${encodeURIComponent(hostPath)}`;
}

/** Apps the launcher knows how to start, in the order they're offered. */
export const OPENABLE_APPS = [
  { key: 'chitubox', label: 'ChiTuBox', kinds: ['SLICED', 'MESH'] },
  { key: 'bambustudio', label: 'Bambu Studio', kinds: ['MESH', 'SLICED'] },
  { key: 'lychee', label: 'Lychee', kinds: ['MESH'] },
  { key: 'orca', label: 'OrcaSlicer', kinds: ['MESH'] },
  { key: 'prusaslicer', label: 'PrusaSlicer', kinds: ['MESH'] },
] as const;

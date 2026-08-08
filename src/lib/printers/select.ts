/**
 * Field set returned to the browser for a printer. Deliberately excludes
 * secretEnc — the encrypted LAN access code never leaves the server, not even
 * in ciphertext.
 */
export const PRINTER_SAFE_SELECT = {
  id: true,
  name: true,
  kind: true,
  host: true,
  port: true,
  serial: true,
  modelName: true,
  buildX: true,
  buildY: true,
  buildZ: true,
  status: true,
  statusJson: true,
  lastSeenAt: true,
  lastError: true,
  enabled: true,
  createdAt: true,
  updatedAt: true,
} as const;

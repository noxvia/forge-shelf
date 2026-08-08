import fs from 'node:fs';
import mqtt, { type MqttClient } from 'mqtt';
import { Client as FtpClient } from 'basic-ftp';
import {
  PrinterError,
  type PrinterAdapter,
  type PrinterStatus,
  type PrinterState,
  type PrinterTarget,
  type UploadResult,
} from './types';

/**
 * Bambu Lab printers in LAN mode.
 *
 * Two channels, both undocumented by Bambu and reverse-engineered by the
 * community — expect firmware updates to move things:
 *
 *   • MQTT over TLS on 8883, user "bblp", password = the LAN Access Code from
 *     the printer's network screen. Requests go to device/<serial>/request,
 *     reports come back on device/<serial>/report.
 *   • Implicit FTPS on 990, same credentials, for uploading the .gcode.3mf.
 *
 * Both use the printer's self-signed certificate, so verification is off. That
 * is safe enough on a LAN but it does mean the connection is unauthenticated in
 * the TLS sense; the access code is the only real credential.
 *
 * Prerequisites on the printer: LAN Only Mode (or at minimum LAN mode enabled)
 * and Developer/LAN Mode liveview if you also want the camera.
 */

const MQTT_PORT = 8883;
const FTP_PORT = 990;
const USER = 'bblp';

/**
 * Directory the .3mf is uploaded into, and the URL scheme used to reference it
 * in the print command.
 *
 * This is the one setting most likely to need changing across models/firmware.
 * Known-working alternatives if a print refuses to start:
 *   • root upload + "ftp:///<name>"
 *   • "file:///sdcard/<name>"        (older X1 firmware)
 *   • "file:///mnt/sdcard/<name>"    (some P1 builds)
 */
const REMOTE_DIR = '/cache';
const remoteUrl = (name: string) => `ftp://${REMOTE_DIR}/${name}`;

export const bambuAdapter: PrinterAdapter = {
  kind: 'FDM_BAMBU',
  accepts: ['3mf', 'gcode.3mf', 'gcode'],

  async status(target) {
    const report = await requestReport(target);
    return parseStatus(report);
  },

  async upload(target, localPath, remoteName, onProgress) {
    requireSecret(target);
    const client = new FtpClient(30_000);
    client.ftp.verbose = false;

    try {
      await client.access({
        host: target.host,
        port: FTP_PORT,
        user: USER,
        password: target.secret!,
        secure: 'implicit',
        secureOptions: {
          rejectUnauthorized: false,
          // Bambu's FTP server insists on TLS session resumption for the data
          // channel; basic-ftp reuses the control session when told not to
          // enforce a fresh handshake.
          minVersion: 'TLSv1.2',
        },
      });

      if (onProgress) {
        const total = fs.statSync(localPath).size;
        client.trackProgress((info) => onProgress(info.bytes, total));
      }

      // The printer may not have the directory yet on a factory-fresh machine.
      try {
        await client.ensureDir(REMOTE_DIR);
      } catch {
        // ensureDir also cd's into it; if it failed we upload to the root below.
      }

      await client.uploadFrom(localPath, remoteName);
      client.trackProgress();

      return { remoteFilename: remoteName, remotePath: `${REMOTE_DIR}/${remoteName}` };
    } catch (err) {
      throw new PrinterError(`FTPS upload to ${target.name} failed: ${describe(err)}`, true);
    } finally {
      client.close();
    }
  },

  async start(target, upload) {
    const name = upload.remoteFilename;
    await publish(target, {
      print: {
        sequence_id: seq(),
        command: 'project_file',
        // Which plate inside the .3mf to print. Orca names them plate_1, _2, …
        param: 'Metadata/plate_1.gcode',
        url: remoteUrl(name),
        subtask_name: name.replace(/\.gcode\.3mf$|\.3mf$/i, ''),
        project_id: '0',
        profile_id: '0',
        task_id: '0',
        subtask_id: '0',
        // Conservative defaults: skip the calibrations that add minutes to every
        // print, keep bed levelling because skipping it causes real failures.
        timelapse: false,
        bed_leveling: true,
        flow_cali: false,
        vibration_cali: true,
        layer_inspect: false,
        use_ams: false,
      },
    });
  },

  async pause(target) {
    await publish(target, { print: { sequence_id: seq(), command: 'pause' } });
  },

  async resume(target) {
    await publish(target, { print: { sequence_id: seq(), command: 'resume' } });
  },

  async cancel(target) {
    await publish(target, { print: { sequence_id: seq(), command: 'stop' } });
  },
};

// ---------------------------------------------------------------------------
// MQTT plumbing
// ---------------------------------------------------------------------------

let sequence = 1;
const seq = () => String(sequence++);

function requireSecret(target: PrinterTarget): void {
  if (!target.secret) {
    throw new PrinterError(
      `${target.name} has no LAN access code saved. Find it on the printer under ` +
        `Settings → Network, and add it in the printer's settings here.`,
    );
  }
  if (!target.serial) {
    throw new PrinterError(
      `${target.name} has no serial number saved. It's on the printer's about ` +
        `screen and is required to address MQTT topics.`,
    );
  }
}

function connect(target: PrinterTarget): Promise<MqttClient> {
  requireSecret(target);
  const url = `mqtts://${target.host}:${target.port ?? MQTT_PORT}`;

  return new Promise((resolve, reject) => {
    const client = mqtt.connect(url, {
      username: USER,
      password: target.secret!,
      clientId: `forge-shelf-${Math.random().toString(16).slice(2, 10)}`,
      rejectUnauthorized: false,
      protocolVersion: 4,
      connectTimeout: 8000,
      reconnectPeriod: 0, // one shot; the worker decides when to retry
      keepalive: 20,
    });

    const done = (err?: Error) => {
      client.removeAllListeners('connect');
      client.removeAllListeners('error');
      if (err) {
        client.end(true);
        reject(
          new PrinterError(
            `Cannot reach ${target.name} at ${target.host}:8883 — ${err.message}. ` +
              `Check the printer is in LAN mode and the access code is current.`,
            true,
          ),
        );
      } else {
        resolve(client);
      }
    };

    client.once('connect', () => done());
    client.once('error', (err) => done(err));
  });
}

/** Publishes one command and closes. Bambu does not ack these individually. */
async function publish(target: PrinterTarget, payload: unknown): Promise<void> {
  const client = await connect(target);
  try {
    await new Promise<void>((resolve, reject) => {
      client.publish(
        `device/${target.serial}/request`,
        JSON.stringify(payload),
        { qos: 1 },
        (err) => (err ? reject(new PrinterError(`Publish failed: ${err.message}`, true)) : resolve()),
      );
    });
  } finally {
    client.end(true);
  }
}

/**
 * Asks for a full state dump and returns the first report that contains one.
 *
 * The printer pushes reports unprompted too, but those are partial deltas, so we
 * explicitly request `pushall` and wait for a payload with the fields we need.
 */
function requestReport(target: PrinterTarget, timeoutMs = 10_000): Promise<BambuPrint> {
  return new Promise<BambuPrint>((resolve, reject) => {
    connect(target).then((client) => {
      let settled = false;

      const finish = (err: Error | null, value?: BambuPrint) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client.end(true);
        if (err) reject(err);
        else resolve(value!);
      };

      const timer = setTimeout(
        () =>
          finish(
            new PrinterError(
              `${target.name} connected but sent no status within ${timeoutMs / 1000}s`,
              true,
            ),
          ),
        timeoutMs,
      );

      client.on('message', (_topic, buf) => {
        try {
          const msg = JSON.parse(buf.toString()) as { print?: BambuPrint };
          // Deltas arrive constantly; wait for one carrying real state.
          if (msg.print && ('gcode_state' in msg.print || 'mc_percent' in msg.print)) {
            finish(null, msg.print);
          }
        } catch {
          // Non-JSON chatter; ignore.
        }
      });

      client.subscribe(`device/${target.serial}/report`, { qos: 0 }, (err) => {
        if (err) {
          finish(new PrinterError(`Subscribe failed: ${err.message}`, true));
          return;
        }
        client.publish(
          `device/${target.serial}/request`,
          JSON.stringify({ pushing: { sequence_id: seq(), command: 'pushall' } }),
          { qos: 1 },
        );
      });
    }, reject);
  });
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

interface BambuPrint {
  gcode_state?: string;
  mc_percent?: number;
  mc_remaining_time?: number; // minutes
  layer_num?: number;
  total_layer_num?: number;
  subtask_name?: string;
  gcode_file?: string;
  nozzle_temper?: number;
  bed_temper?: number;
  chamber_temper?: number;
  print_error?: number;
  [k: string]: unknown;
}

const STATE_MAP: Record<string, PrinterState> = {
  IDLE: 'idle',
  PREPARE: 'printing',
  SLICING: 'printing',
  RUNNING: 'printing',
  PAUSE: 'paused',
  FINISH: 'finished',
  FAILED: 'error',
  UNKNOWN: 'idle',
};

function parseStatus(p: BambuPrint): PrinterStatus {
  const gcodeState = String(p.gcode_state ?? 'UNKNOWN').toUpperCase();
  let state = STATE_MAP[gcodeState] ?? 'idle';
  if (p.print_error && p.print_error !== 0) state = 'error';

  return {
    state,
    progress: typeof p.mc_percent === 'number' ? clamp(p.mc_percent) : null,
    layerCurrent: numOrNull(p.layer_num),
    layerTotal: numOrNull(p.total_layer_num),
    etaSeconds:
      typeof p.mc_remaining_time === 'number' ? Math.max(0, p.mc_remaining_time) * 60 : null,
    jobName: (p.subtask_name || p.gcode_file || null) as string | null,
    nozzleTemp: numOrNull(p.nozzle_temper),
    bedTemp: numOrNull(p.bed_temper),
    chamberTemp: numOrNull(p.chamber_temper),
    message: p.print_error ? `Printer error code ${p.print_error}` : null,
    raw: p,
  };
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
const numOrNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

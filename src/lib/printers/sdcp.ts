import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import {
  PrinterError,
  type PrinterAdapter,
  type PrinterStatus,
  type PrinterState,
  type PrinterTarget,
  type UploadResult,
} from './types';

/**
 * Resin printers speaking SDCP — Elegoo's "Smart Device Control Protocol",
 * used by the Mars 4 / Saturn 4 generation and by several Anycubic boards with
 * ChiTu firmware.
 *
 * Three transports on one device:
 *   • UDP :3000  — discovery ("M99999" broadcast). See discovery.ts.
 *   • WS  :3030/websocket — commands and status, JSON envelopes.
 *   • HTTP :3030/uploadFile/upload — chunked multipart file upload.
 *
 * SDCP is publicly specified but firmware coverage is uneven: older Mars 3 /
 * Photon hardware predates it entirely and will not respond. There is no
 * authentication whatsoever — anything on the LAN can drive the printer — so
 * keep these machines on a network you trust.
 */

const WS_PORT = 3030;
const CHUNK_SIZE = 1024 * 1024; // the reference implementation uses 1 MiB

enum Cmd {
  Status = 0,
  Attributes = 1,
  Start = 128,
  Pause = 129,
  Stop = 130,
  Resume = 131,
}

/** SDCP CurrentStatus values. */
enum MachineStatus {
  Idle = 0,
  Printing = 1,
  FileTransferring = 2,
  ExposureTesting = 3,
  DevicesTesting = 4,
}

/** SDCP PrintInfo.Status values. */
enum PrintStatus {
  Idle = 0,
  Homing = 1,
  Dropping = 2,
  Exposuring = 3,
  Lifting = 4,
  Pausing = 5,
  Paused = 6,
  Stopping = 7,
  Stopped = 8,
  Complete = 9,
  FileChecking = 10,
}

export const sdcpAdapter: PrinterAdapter = {
  kind: 'RESIN_SDCP',
  accepts: ['ctb', 'cbddlp', 'goo', 'pwmx', 'pwma', 'pws'],

  async status(target) {
    const payload = await requestStatus(target);
    return parseStatus(payload);
  },

  async upload(target, localPath, remoteName, onProgress) {
    const data = await fsp.readFile(localPath);
    const total = data.length;
    const md5 = crypto.createHash('md5').update(data).digest('hex');
    const uuid = crypto.randomUUID().replace(/-/g, '');
    const url = `http://${target.host}:${target.port ?? WS_PORT}/uploadFile/upload`;

    for (let offset = 0; offset < total; offset += CHUNK_SIZE) {
      const chunk = data.subarray(offset, Math.min(offset + CHUNK_SIZE, total));

      const form = new FormData();
      form.append('S-File-MD5', md5);
      form.append('Check', '1');
      form.append('Offset', String(offset));
      form.append('Uuid', uuid);
      form.append('TotalSize', String(total));
      form.append('File', new Blob([chunk]), remoteName);

      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          body: form,
          signal: AbortSignal.timeout(60_000),
        });
      } catch (err) {
        throw new PrinterError(
          `Upload to ${target.name} failed at byte ${offset}: ${describe(err)}`,
          true,
        );
      }

      if (!res.ok) {
        throw new PrinterError(
          `Upload to ${target.name} rejected at byte ${offset}: HTTP ${res.status}`,
          true,
        );
      }

      // The printer answers with {"success":bool,...}; a false here usually means
      // the MD5 check failed or storage is full.
      const body = (await res.json().catch(() => null)) as { success?: boolean } | null;
      if (body && body.success === false) {
        throw new PrinterError(
          `${target.name} rejected the upload at byte ${offset} — check free space on the printer.`,
        );
      }

      onProgress?.(Math.min(offset + chunk.length, total), total);
    }

    return { remoteFilename: remoteName, remotePath: `/local/${remoteName}` };
  },

  async start(target, upload) {
    // Firmware differs on whether it wants a bare name or a rooted path. The
    // rooted form works on every board tested; fall back to the bare name.
    try {
      await command(target, Cmd.Start, { Filename: upload.remotePath, StartLayer: 0 });
    } catch (err) {
      if (err instanceof PrinterError && !err.retriable) {
        await command(target, Cmd.Start, { Filename: upload.remoteFilename, StartLayer: 0 });
        return;
      }
      throw err;
    }
  },

  async pause(target) {
    await command(target, Cmd.Pause, {});
  },

  async resume(target) {
    await command(target, Cmd.Resume, {});
  },

  async cancel(target) {
    await command(target, Cmd.Stop, {});
  },
};

// ---------------------------------------------------------------------------
// WebSocket transport
// ---------------------------------------------------------------------------

interface SdcpEnvelope {
  Id?: string;
  Topic?: string;
  Data?: Record<string, unknown>;
  Status?: Record<string, unknown>;
  Attributes?: Record<string, unknown>;
  Error?: Record<string, unknown>;
}

function open(target: PrinterTarget, timeoutMs = 8000): Promise<WebSocket> {
  const url = `ws://${target.host}:${target.port ?? WS_PORT}/websocket`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { handshakeTimeout: timeoutMs });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new PrinterError(`${target.name} did not answer on ${url}`, true));
    }, timeoutMs);

    ws.once('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once('error', (err: Error) => {
      clearTimeout(timer);
      ws.terminate();
      reject(
        new PrinterError(
          `Cannot reach ${target.name} at ${url} — ${err.message}. Confirm the IP and ` +
            `that the printer's firmware supports SDCP.`,
          true,
        ),
      );
    });
  });
}

function envelope(target: PrinterTarget, cmd: Cmd, data: Record<string, unknown>) {
  const mainboardId = target.serial ?? '';
  return {
    Id: crypto.randomUUID().replace(/-/g, '').slice(0, 16),
    Data: {
      Cmd: cmd,
      Data: data,
      RequestID: crypto.randomUUID().replace(/-/g, ''),
      MainboardID: mainboardId,
      TimeStamp: Math.floor(Date.now() / 1000),
      From: 0, // 0 = local PC client
    },
    Topic: `sdcp/request/${mainboardId}`,
  };
}

/**
 * Sends one command and waits for the matching response envelope.
 * SDCP replies with an Ack of 0 on success; anything else is a real refusal.
 */
async function command(
  target: PrinterTarget,
  cmd: Cmd,
  data: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<SdcpEnvelope> {
  if (!target.serial) {
    throw new PrinterError(
      `${target.name} has no mainboard ID saved, and SDCP needs one to address any ` +
        `command. Press Refresh on the printer's card — that asks ${target.host} for it ` +
        `directly and saves the answer.`,
    );
  }

  const ws = await open(target);
  const request = envelope(target, cmd, data);

  return new Promise<SdcpEnvelope>((resolve, reject) => {
    let settled = false;
    const finish = (err: Error | null, value?: SdcpEnvelope) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      if (err) reject(err);
      else resolve(value!);
    };

    const timer = setTimeout(
      () => finish(new PrinterError(`${target.name} did not acknowledge command ${cmd}`, true)),
      timeoutMs,
    );

    ws.on('message', (raw: WebSocket.RawData) => {
      let msg: SdcpEnvelope;
      try {
        msg = JSON.parse(raw.toString()) as SdcpEnvelope;
      } catch {
        return;
      }

      if (msg.Topic?.startsWith('sdcp/error/')) {
        finish(new PrinterError(`${target.name} reported an error: ${JSON.stringify(msg.Data)}`));
        return;
      }

      if (!msg.Topic?.startsWith('sdcp/response/')) return;

      const inner = msg.Data as { Cmd?: number; Data?: { Ack?: number } } | undefined;
      if (inner?.Cmd !== cmd) return;

      const ack = inner.Data?.Ack;
      if (ack !== undefined && ack !== 0) {
        finish(new PrinterError(`${target.name} refused command ${cmd} (Ack ${ack})`));
        return;
      }
      finish(null, msg);
    });

    ws.on('error', (err: Error) => finish(new PrinterError(describe(err), true)));
    ws.on('close', () =>
      finish(new PrinterError(`${target.name} closed the connection before replying`, true)),
    );

    ws.send(JSON.stringify(request));
  });
}

/**
 * Status arrives on its own topic rather than as a command response, so this
 * subscribes, nudges the printer with Cmd 0, and takes the first status push.
 */
function requestStatus(target: PrinterTarget, timeoutMs = 10_000): Promise<SdcpEnvelope> {
  if (!target.serial) {
    throw new PrinterError(
      `${target.name} has no mainboard ID saved. Press Refresh on its card to fetch it ` +
        `from ${target.host}.`,
    );
  }

  return open(target).then(
    (ws) =>
      new Promise<SdcpEnvelope>((resolve, reject) => {
        let settled = false;
        const finish = (err: Error | null, value?: SdcpEnvelope) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          ws.close();
          if (err) reject(err);
          else resolve(value!);
        };

        const timer = setTimeout(
          () => finish(new PrinterError(`${target.name} sent no status in time`, true)),
          timeoutMs,
        );

        ws.on('message', (raw: WebSocket.RawData) => {
          let msg: SdcpEnvelope;
          try {
            msg = JSON.parse(raw.toString()) as SdcpEnvelope;
          } catch {
            return;
          }
          // Printers announce their state on connect and again after Cmd 0.
          if (msg.Status || msg.Topic?.startsWith('sdcp/status/')) finish(null, msg);
        });

        ws.on('error', (err: Error) => finish(new PrinterError(describe(err), true)));
        ws.on('close', () => finish(new PrinterError('Connection closed before status', true)));

        ws.send(JSON.stringify(envelope(target, Cmd.Status, {})));
      }),
  );
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

interface SdcpPrintInfo {
  Status?: number;
  CurrentLayer?: number;
  TotalLayer?: number;
  CurrentTicks?: number;
  TotalTicks?: number;
  Filename?: string;
  ErrorNumber?: number;
  TaskId?: string;
}

function parseStatus(msg: SdcpEnvelope): PrinterStatus {
  const status = (msg.Status ?? (msg.Data?.Status as Record<string, unknown>) ?? {}) as {
    CurrentStatus?: number[] | number;
    PrintInfo?: SdcpPrintInfo;
    // Firmware disagrees on the name. A Saturn 4 Ultra on V1.5.3 sends
    // TempOfUVLED; the published spec calls it UvledTempSensor. Accept both.
    TempOfUVLED?: number;
    UvledTempSensor?: number;
    /** Exposures since the release film was last reset — FEP wear tracking. */
    ReleaseFilm?: number;
  };

  const machine = Array.isArray(status.CurrentStatus)
    ? status.CurrentStatus[0]
    : status.CurrentStatus;
  const info = status.PrintInfo ?? {};

  let state: PrinterState = 'idle';
  switch (info.Status) {
    case PrintStatus.Homing:
    case PrintStatus.Dropping:
    case PrintStatus.Exposuring:
    case PrintStatus.Lifting:
    case PrintStatus.FileChecking:
      state = 'printing';
      break;
    case PrintStatus.Pausing:
    case PrintStatus.Paused:
      state = 'paused';
      break;
    case PrintStatus.Complete:
      state = 'finished';
      break;
    case PrintStatus.Stopping:
    case PrintStatus.Stopped:
      state = 'idle';
      break;
    default:
      state = machine === MachineStatus.Printing ? 'printing' : 'idle';
  }
  if (info.ErrorNumber && info.ErrorNumber !== 0) state = 'error';

  const layerCurrent = numOrNull(info.CurrentLayer);
  const layerTotal = numOrNull(info.TotalLayer);
  const progress =
    layerCurrent !== null && layerTotal !== null && layerTotal > 0
      ? Math.max(0, Math.min(100, Math.round((layerCurrent / layerTotal) * 100)))
      : null;

  // Ticks are milliseconds of print time.
  const eta =
    typeof info.TotalTicks === 'number' && typeof info.CurrentTicks === 'number'
      ? Math.max(0, Math.round((info.TotalTicks - info.CurrentTicks) / 1000))
      : null;

  return {
    state,
    progress,
    layerCurrent,
    layerTotal,
    etaSeconds: eta,
    jobName: info.Filename ?? null,
    uvLedTemp: numOrNull(status.TempOfUVLED) ?? numOrNull(status.UvledTempSensor),
    message: info.ErrorNumber ? `Printer error code ${info.ErrorNumber}` : null,
    raw: msg,
  };
}

const numOrNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

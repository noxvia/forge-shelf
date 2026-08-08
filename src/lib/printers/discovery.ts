import dgram from 'node:dgram';
import { PrinterKind } from '@prisma/client';
import { env } from '../env';

/**
 * LAN discovery.
 *
 * SDCP resin printers answer a UDP broadcast of the literal string "M99999" on
 * port 3000. Bambu printers announce themselves over SSDP on 239.255.255.250,
 * but only with an opaque USN — the serial and access code still have to be read
 * off the printer, so we surface the address and let the user fill in the rest.
 *
 * Broadcast traffic does not cross Docker's bridge network. Inside the default
 * compose setup this returns nothing; use docker-compose.lan.yml (host
 * networking) or just add printers by IP.
 */

export interface Discovered {
  kind: PrinterKind;
  host: string;
  name: string;
  serial: string | null;
  modelName: string | null;
  firmware: string | null;
  buildX: number | null;
  buildY: number | null;
  buildZ: number | null;
  /** True when the user still has to supply credentials before it will work. */
  needsSecret: boolean;
}

export async function discoverAll(timeoutMs = 3000): Promise<Discovered[]> {
  const [sdcp, bambu] = await Promise.all([
    discoverSdcp(timeoutMs).catch((e) => {
      console.warn('[discovery] SDCP sweep failed:', e);
      return [] as Discovered[];
    }),
    discoverBambu(timeoutMs).catch((e) => {
      console.warn('[discovery] SSDP sweep failed:', e);
      return [] as Discovered[];
    }),
  ]);

  // De-duplicate on host; a printer answering twice is one printer.
  const byHost = new Map<string, Discovered>();
  for (const d of [...sdcp, ...bambu]) if (!byHost.has(d.host)) byHost.set(d.host, d);
  return [...byHost.values()];
}

// ---------------------------------------------------------------------------
// SDCP — UDP broadcast on 3000
// ---------------------------------------------------------------------------

interface SdcpDiscoveryReply {
  Id?: string;
  Data?: {
    Name?: string;
    MachineName?: string;
    BrandName?: string;
    MainboardIP?: string;
    MainboardID?: string;
    ProtocolVersion?: string;
    FirmwareVersion?: string;
    Resolution?: string;
    XYZsize?: string;
  };
}

export function discoverSdcp(timeoutMs = 3000): Promise<Discovered[]> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const found: Discovered[] = [];

    const finish = () => {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(found);
    };

    socket.on('error', (err) => {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      reject(err);
    });

    socket.on('message', (buf, rinfo) => {
      try {
        const reply = JSON.parse(buf.toString()) as SdcpDiscoveryReply;
        const d = reply.Data;
        if (!d?.MainboardID) return;

        const size = parseXyz(d.XYZsize);
        found.push({
          kind: PrinterKind.RESIN_SDCP,
          host: d.MainboardIP || rinfo.address,
          name: d.Name || d.MachineName || 'Resin printer',
          serial: d.MainboardID,
          modelName: d.MachineName || d.Name || null,
          firmware: d.FirmwareVersion ?? null,
          buildX: size?.x ?? null,
          buildY: size?.y ?? null,
          buildZ: size?.z ?? null,
          // SDCP has no auth at all, so nothing more is needed to drive it.
          needsSecret: false,
        });
      } catch {
        // Not one of ours.
      }
    });

    socket.bind(() => {
      socket.setBroadcast(true);
      const probe = Buffer.from('M99999');
      socket.send(probe, 0, probe.length, 3000, env.sdcpBroadcast, (err) => {
        if (err) {
          try {
            socket.close();
          } catch {
            /* ignore */
          }
          reject(err);
        }
      });
      setTimeout(finish, timeoutMs);
    });
  });
}

/**
 * Asks one printer, by address, to identify itself.
 *
 * This is the same "M99999" packet as the broadcast sweep, sent unicast — which
 * matters because unicast crosses Docker's bridge network and broadcast does
 * not. It is how a printer added by IP gets its mainboard ID without the user
 * having to find it, and without host networking.
 */
export function probeSdcpHost(host: string, timeoutMs = 2500): Promise<Discovered | null> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4' });
    let settled = false;

    const finish = (value: Discovered | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    socket.on('error', () => finish(null));

    socket.on('message', (buf, rinfo) => {
      try {
        const reply = JSON.parse(buf.toString()) as SdcpDiscoveryReply;
        const d = reply.Data;
        if (!d?.MainboardID) return;

        const size = parseXyz(d.XYZsize);
        finish({
          kind: PrinterKind.RESIN_SDCP,
          host: d.MainboardIP || rinfo.address,
          name: d.MachineName || d.Name || 'Resin printer',
          serial: d.MainboardID,
          modelName: d.MachineName || d.Name || null,
          firmware: d.FirmwareVersion ?? null,
          buildX: size?.x ?? null,
          buildY: size?.y ?? null,
          buildZ: size?.z ?? null,
          needsSecret: false,
        });
      } catch {
        // Not an SDCP reply.
      }
    });

    const probe = Buffer.from('M99999');
    socket.send(probe, 0, probe.length, 3000, host, (err) => {
      if (err) finish(null);
    });
  });
}

/** SDCP reports build volume as "218.88x122.88x220". */
function parseXyz(raw: string | undefined): { x: number; y: number; z: number } | null {
  if (!raw) return null;
  const parts = raw.split(/[x×,\s]+/i).map(Number);
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return { x: parts[0], y: parts[1], z: parts[2] };
}

// ---------------------------------------------------------------------------
// Bambu — SSDP on 239.255.255.250:2021
// ---------------------------------------------------------------------------

export function discoverBambu(timeoutMs = 3000): Promise<Discovered[]> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const found = new Map<string, Discovered>();

    const finish = () => {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      resolve([...found.values()]);
    };

    socket.on('error', (err) => {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      reject(err);
    });

    socket.on('message', (buf, rinfo) => {
      const text = buf.toString();
      if (!/bambu|BBL/i.test(text)) return;

      const usn = /USN:\s*(\S+)/i.exec(text)?.[1] ?? null;
      const model = /DevModel\.bambu\.com:\s*(\S+)/i.exec(text)?.[1] ?? null;
      const name = /DevName\.bambu\.com:\s*(.+)/i.exec(text)?.[1]?.trim() ?? null;

      found.set(rinfo.address, {
        kind: PrinterKind.FDM_BAMBU,
        host: rinfo.address,
        name: name || model || 'Bambu Lab printer',
        // The USN is the device serial on current firmware, but verify it against
        // the printer's about screen before trusting it.
        serial: usn,
        modelName: model,
        firmware: null,
        buildX: null,
        buildY: null,
        buildZ: null,
        // The LAN access code can only come from the printer's own screen.
        needsSecret: true,
      });
    });

    socket.bind(2021, () => {
      try {
        socket.addMembership('239.255.255.250');
      } catch (err) {
        // Multicast join fails inside bridge networking; the passive listen
        // below may still catch an announcement if we're on the host network.
        console.warn('[discovery] could not join SSDP group:', err);
      }
      const search = Buffer.from(
        'M-SEARCH * HTTP/1.1\r\n' +
          'HOST: 239.255.255.250:1900\r\n' +
          'MAN: "ssdp:discover"\r\n' +
          'MX: 2\r\n' +
          'ST: urn:bambulab-com:device:3dprinter:1\r\n\r\n',
      );
      socket.send(search, 0, search.length, 1900, '239.255.255.250', () => {
        /* announcements are unsolicited too; ignore send errors */
      });
      setTimeout(finish, timeoutMs);
    });
  });
}

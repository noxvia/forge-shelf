import { prisma } from '@/lib/db';
import { ok, handler } from '@/lib/json';
import { discoverAll } from '@/lib/printers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Sweeps the LAN and returns candidates, flagging ones already configured.
 *
 * Broadcast and multicast do not cross Docker's default bridge network, so this
 * comes back empty unless the containers run with host networking. The response
 * says so explicitly rather than pretending nothing is out there.
 */
export const POST = handler(async () => {
  const found = await discoverAll(3500);

  const existing = await prisma.printer.findMany({
    select: { id: true, host: true, kind: true },
  });
  const known = new Map(existing.map((p) => [`${p.kind}:${p.host}`, p.id]));

  const results = found.map((d) => ({
    ...d,
    alreadyAdded: known.has(`${d.kind}:${d.host}`),
    existingId: known.get(`${d.kind}:${d.host}`) ?? null,
  }));

  return ok({
    results,
    hint:
      results.length === 0
        ? 'Nothing answered. Discovery uses UDP broadcast, which cannot cross ' +
          "Docker's bridge network — either run with docker-compose.lan.yml " +
          '(host networking) or add the printer by IP address, which always works.'
        : null,
  });
});

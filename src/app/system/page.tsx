import { CheckCircle2, XCircle } from 'lucide-react';
import { toolStatus } from '@/lib/tools/status';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

/**
 * Diagnostics. Rendered on the server because everything it reports — binaries
 * on disk, database reachability, how storage maps onto the host — is
 * server-side state.
 */
export default async function SystemPage() {
  const tools = await toolStatus();

  const counts = await Promise.all([
    prisma.model.count().catch(() => -1),
    prisma.modelFile.count().catch(() => -1),
    prisma.printer.count().catch(() => -1),
    prisma.printJob.count().catch(() => -1),
    prisma.plate.count().catch(() => -1),
  ]);
  const [models, files, printers, jobs, plates] = counts;
  const dbOk = models >= 0;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">System</h1>

      <section className="card p-4">
        <h2 className="mb-3 text-sm font-semibold">Tools</h2>
        <ul className="space-y-2">
          {tools.map((tool) => (
            <li key={tool.name} className="flex items-start gap-3 rounded bg-panel2 p-3">
              {tool.installed ? (
                <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-good" />
              ) : (
                <XCircle size={16} className="mt-0.5 shrink-0 text-bad" />
              )}
              <div className="min-w-0">
                <p className="font-medium">{tool.name}</p>
                <p className="text-sm text-muted">{tool.purpose}</p>
                <p className="mt-0.5 break-all font-mono text-xs text-muted">{tool.path}</p>
              </div>
            </li>
          ))}
        </ul>

        <p className="mt-3 text-sm text-muted">
          Slicing happens in your desktop slicer. This catalogue stores, inspects and arranges
          files, then hands them over.
        </p>
      </section>

      <section className="card p-4">
        <h2 className="mb-3 text-sm font-semibold">Storage &amp; database</h2>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Stat label="Storage path (in container)" value={env.storageDir} mono />
          <Stat label="Storage path (on this machine)" value={env.hostDataDir ?? 'not set'} mono />
          <Stat label="Database" value={dbOk ? 'connected' : 'unreachable'} />
          <Stat label="Models" value={String(models)} />
          <Stat label="Files" value={String(files)} />
          <Stat label="Plates" value={String(plates)} />
          <Stat label="Printers" value={String(printers)} />
          <Stat label="Print jobs" value={String(jobs)} />
        </dl>

        {!env.hostDataDir && (
          <p className="mt-3 rounded bg-warn/10 px-3 py-2 text-sm text-warn">
            HOST_DATA_DIR isn&apos;t set, so the &quot;open in ChiTuBox / Bambu Studio&quot;
            buttons stay hidden — the catalogue can&apos;t tell a desktop application where its
            files are. Set it to the folder the <code className="font-mono">./data</code> volume
            points at and restart.
          </p>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={mono ? 'break-all font-mono text-sm' : 'text-sm'}>{value}</dd>
    </div>
  );
}

import { CheckCircle2, XCircle } from 'lucide-react';
import { toolStatus } from '@/lib/slicer';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

/**
 * Diagnostics. Rendered on the server because everything it reports — binaries
 * on disk, database reachability — is server-side state.
 */
export default async function SystemPage() {
  const tools = await toolStatus();

  const counts = await Promise.all([
    prisma.model.count().catch(() => -1),
    prisma.modelFile.count().catch(() => -1),
    prisma.printer.count().catch(() => -1),
    prisma.printJob.count().catch(() => -1),
    prisma.sliceTask.count().catch(() => -1),
  ]);
  const [models, files, printers, jobs, slices] = counts;
  const dbOk = models >= 0;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">System</h1>

      <section className="card p-4">
        <h2 className="mb-3 text-sm font-semibold">Slicer toolchain</h2>
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

        {tools.some((t) => !t.installed) && (
          <p className="mt-3 rounded bg-warn/10 px-3 py-2 text-sm text-warn">
            Missing binaries mean those slicing paths will fail with a clear error rather
            than silently producing nothing. Rebuild with{' '}
            <code className="font-mono">--build-arg INSTALL_SLICERS=true</code>, or check the
            build log — the Dockerfile warns instead of failing when a release URL moves.
          </p>
        )}
      </section>

      <section className="card p-4">
        <h2 className="mb-3 text-sm font-semibold">Storage &amp; database</h2>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Stat label="Storage path" value={env.storageDir} mono />
          <Stat label="Database" value={dbOk ? 'connected' : 'unreachable'} />
          <Stat label="Models" value={String(models)} />
          <Stat label="Files" value={String(files)} />
          <Stat label="Printers" value={String(printers)} />
          <Stat label="Print jobs" value={String(jobs)} />
          <Stat label="Slice tasks" value={String(slices)} />
        </dl>
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

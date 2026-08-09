'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Plus, Loader2, Grid3x3, Trash2 } from 'lucide-react';
import { api, post, del, relativeTime } from '@/lib/api-client';

interface PlateSummary {
  id: string;
  name: string;
  updatedAt: string;
  printer: { id: string; name: string } | null;
  profile: { id: string; name: string; technology: string } | null;
  _count: { items: number };
}

export function PlatesList() {
  const router = useRouter();
  const [plates, setPlates] = useState<PlateSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      setPlates(await api<PlateSummary[]>('/api/plates'));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load plates');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setCreating(true);
    try {
      const plate = await post<PlateSummary>('/api/plates', {
        name: `Plate ${new Date().toLocaleDateString()}`,
      });
      router.push(`/plates/${plate.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create plate');
      setCreating(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Build plates</h1>
        <button type="button" className="btn-primary" onClick={create} disabled={creating}>
          {creating ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
          New plate
        </button>
      </div>

      {error && <p className="rounded bg-bad/10 px-3 py-2 text-sm text-bad">{error}</p>}

      {loading && (
        <div className="grid place-items-center py-20 text-muted">
          <Loader2 size={22} className="animate-spin" />
        </div>
      )}

      {!loading && plates.length === 0 && (
        <div className="card grid place-items-center py-16 text-center">
          <Grid3x3 size={28} className="mb-3 text-muted" />
          <p className="font-medium">No build plates yet</p>
          <p className="mt-1 max-w-md text-sm text-muted">
            A plate lets you arrange several models in printer space — move, rotate and scale
            them — then slice the whole arrangement as one job.
          </p>
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {plates.map((plate) => (
          <div key={plate.id} className="card group flex items-start gap-2 p-4">
            <Link href={`/plates/${plate.id}`} className="min-w-0 flex-1">
              <p className="truncate font-medium group-hover:text-accent">{plate.name}</p>
              <p className="mt-0.5 text-xs text-muted">
                {plate._count.items} object{plate._count.items === 1 ? '' : 's'}
                {plate.printer && ` · ${plate.printer.name}`}
                {plate.profile && ` · ${plate.profile.name}`}
              </p>
              <p className="mt-1 text-xs text-muted">edited {relativeTime(plate.updatedAt)}</p>
            </Link>
            <button
              type="button"
              className="text-muted opacity-0 transition-opacity hover:text-bad group-hover:opacity-100"
              onClick={async () => {
                if (!confirm(`Delete plate "${plate.name}"?`)) return;
                try {
                  await del(`/api/plates/${plate.id}`);
                  void load();
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Could not delete');
                }
              }}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

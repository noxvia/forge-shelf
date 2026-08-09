'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamicImport from 'next/dynamic';
import Link from 'next/link';
import clsx from 'clsx';
import { Loader2, Plus, Scissors, Save, Check } from 'lucide-react';
import { api, patch, post, humanSize } from '@/lib/api-client';
import type { SlicerProfile, Printer, ModelSummary } from '@/lib/types';
import { ResinOptions, type ResinOptionsValue } from './ResinOptions';
import type { PlateItem, BuildVolume } from './PlateEditor';

const PlateEditor = dynamicImport(() => import('./PlateEditor').then((m) => m.PlateEditor), {
  ssr: false,
  loading: () => (
    <div className="grid h-[560px] place-items-center rounded-lg border border-edge bg-panel2">
      <Loader2 size={22} className="animate-spin text-muted" />
    </div>
  ),
});

interface Plate {
  id: string;
  name: string;
  printerId: string | null;
  profileId: string | null;
  options: Record<string, unknown> | null;
  items: PlateItem[];
  printer: { id: string; name: string; buildX: number | null; buildY: number | null; buildZ: number | null } | null;
  profile: { id: string; name: string; technology: string } | null;
  tasks?: {
    id: string;
    status: string;
    error: string | null;
    outputFile: { id: string; filename: string; sizeBytes: string; meta?: unknown } | null;
    profile: { name: string };
  }[];
}

/** Falls back to a common resin plate when no printer is chosen yet. */
const DEFAULT_VOLUME: BuildVolume = { x: 218.88, y: 122.88, z: 220 };

export function PlateWorkspace({ plateId }: { plateId: string }) {
  const [plate, setPlate] = useState<Plate | null>(null);
  const [profiles, setProfiles] = useState<SlicerProfile[]>([]);
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [resinOptions, setResinOptions] = useState<ResinOptionsValue>({});

  const load = useCallback(async () => {
    try {
      const data = await api<Plate>(`/api/plates/${plateId}`);
      setPlate(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load plate');
    }
  }, [plateId]);

  useEffect(() => {
    void load();
    api<SlicerProfile[]>('/api/profiles').then(setProfiles).catch(() => setProfiles([]));
    api<Printer[]>('/api/printers').then(setPrinters).catch(() => setPrinters([]));
  }, [load]);

  // Poll only while a slice is running.
  useEffect(() => {
    if (!plate?.tasks?.some((t) => t.status === 'QUEUED' || t.status === 'RUNNING')) return;
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [plate, load]);

  const volume: BuildVolume = useMemo(() => {
    const p = plate?.printer;
    if (p?.buildX && p.buildY && p.buildZ) return { x: p.buildX, y: p.buildY, z: p.buildZ };
    return DEFAULT_VOLUME;
  }, [plate?.printer]);

  /** Local, immediate transform update during a drag. */
  const applyLocal = useCallback((id: string, t: Partial<PlateItem>) => {
    setPlate((p) =>
      p ? { ...p, items: p.items.map((i) => (i.id === id ? { ...i, ...t } : i)) } : p,
    );
    setDirty(true);
  }, []);

  const saveRef = useRef<Plate | null>(null);
  saveRef.current = plate;

  const save = useCallback(async () => {
    const current = saveRef.current;
    if (!current) return;
    setBusy(true);
    try {
      await patch(`/api/plates/${plateId}`, {
        items: current.items.map((i) => ({
          id: i.id,
          posX: i.posX, posY: i.posY, posZ: i.posZ,
          rotX: i.rotX, rotY: i.rotY, rotZ: i.rotZ,
          scale: i.scale,
        })),
      });
      setDirty(false);
      setNotice('Layout saved');
      setTimeout(() => setNotice(null), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save layout');
    } finally {
      setBusy(false);
    }
  }, [plateId]);

  const selected = plate?.items.find((i) => i.id === selectedId) ?? null;
  const selectedProfile = profiles.find((p) => p.id === plate?.profileId);

  if (error && !plate) return <p className="rounded bg-bad/10 px-4 py-3 text-sm text-bad">{error}</p>;
  if (!plate) {
    return (
      <div className="grid place-items-center py-24 text-muted">
        <Loader2 size={22} className="animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{plate.name}</h1>
          <p className="text-sm text-muted">
            {plate.items.length} object{plate.items.length === 1 ? '' : 's'}
            {plate.printer ? ` · ${plate.printer.name}` : ' · no printer selected'}
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" className="btn-secondary" onClick={() => setShowAdd(true)}>
            <Plus size={14} />
            Add model
          </button>
          <button
            type="button"
            className={clsx(dirty ? 'btn-primary' : 'btn-secondary')}
            onClick={save}
            disabled={busy || !dirty}
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : dirty ? <Save size={14} /> : <Check size={14} />}
            {dirty ? 'Save layout' : 'Saved'}
          </button>
        </div>
      </header>

      {error && <p className="rounded bg-bad/10 px-3 py-2 text-sm text-bad">{error}</p>}
      {notice && <p className="rounded bg-good/10 px-3 py-2 text-sm text-good">{notice}</p>}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <PlateEditor
          items={plate.items}
          volume={volume}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onTransform={applyLocal}
          onCommit={save}
          onRemove={async (id) => {
            await patch(`/api/plates/${plateId}`, { removeItemIds: [id] });
            setSelectedId(null);
            void load();
          }}
        />

        <aside className="space-y-4">
          <section className="card p-3">
            <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted">
              Objects
            </h2>
            <ul className="space-y-1">
              {plate.items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={clsx(
                      'w-full truncate rounded px-2 py-1.5 text-left text-sm',
                      selectedId === item.id ? 'bg-panel2 text-ink' : 'text-muted hover:bg-panel2/60',
                    )}
                    onClick={() => setSelectedId(item.id)}
                  >
                    {item.file.filename}
                  </button>
                </li>
              ))}
              {plate.items.length === 0 && (
                <li className="px-2 py-1.5 text-sm text-muted">Nothing on the plate yet.</li>
              )}
            </ul>
          </section>

          {selected && (
            <section className="card p-3">
              <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted">
                Transform
              </h2>
              <div className="grid grid-cols-3 gap-2">
                {(['posX', 'posY', 'posZ'] as const).map((k) => (
                  <Num key={k} label={k.replace('pos', '') + ' mm'} value={selected[k]}
                    onChange={(v) => { applyLocal(selected.id, { [k]: v }); }} />
                ))}
                {(['rotX', 'rotY', 'rotZ'] as const).map((k) => (
                  <Num key={k} label={k.replace('rot', '') + '°'} value={selected[k]} step={5}
                    onChange={(v) => { applyLocal(selected.id, { [k]: v }); }} />
                ))}
                <Num label="Scale" value={selected.scale} step={0.1}
                  onChange={(v) => { applyLocal(selected.id, { scale: v || 1 }); }} />
              </div>
              <button type="button" className="btn-secondary mt-2 w-full justify-center" onClick={save} disabled={busy}>
                Apply
              </button>
            </section>
          )}

          <section className="card space-y-3 p-3">
            <h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-muted">Slice</h2>

            <div>
              <label className="label" htmlFor="plate-printer">Printer</label>
              <select id="plate-printer" className="w-full" value={plate.printerId ?? ''}
                onChange={async (e) => {
                  await patch(`/api/plates/${plateId}`, { printerId: e.target.value || null });
                  void load();
                }}>
                <option value="">Choose a printer…</option>
                {printers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>

            <div>
              <label className="label" htmlFor="plate-profile">Profile</label>
              <select id="plate-profile" className="w-full" value={plate.profileId ?? ''}
                onChange={async (e) => {
                  await patch(`/api/plates/${plateId}`, { profileId: e.target.value || null });
                  void load();
                }}>
                <option value="">Choose a profile…</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>{p.name} ({p.technology})</option>
                ))}
              </select>
            </div>

            {selectedProfile?.technology === 'SLA' && (
              <ResinOptions value={resinOptions} onChange={setResinOptions} />
            )}

            <button
              type="button"
              className="btn-primary w-full justify-center"
              disabled={busy || plate.items.length === 0 || !plate.profileId}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  if (dirty) await save();
                  const { drainHoleCount, drainHoleDiameterMm, ...rest } = resinOptions;
                  const options = {
                    ...rest,
                    ...(drainHoleCount
                      ? { drainHoles: { count: drainHoleCount, diameterMm: drainHoleDiameterMm ?? 3 } }
                      : {}),
                  };
                  const res = await post<{ warnings?: string[] }>(`/api/plates/${plateId}/slice`, {
                    options: Object.keys(options).length ? options : undefined,
                  });
                  setNotice(res.warnings?.length ? res.warnings.join(' ') : 'Plate queued for slicing');
                  await load();
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Could not queue the plate');
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Scissors size={14} />
              Slice plate
            </button>
          </section>

          {plate.tasks && plate.tasks.length > 0 && (
            <section className="card p-3">
              <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted">
                Recent slices
              </h2>
              <ul className="space-y-2 text-sm">
                {plate.tasks.map((t) => (
                  <li key={t.id} className="rounded bg-panel2 p-2">
                    <p className="flex items-center gap-2">
                      <span className={clsx(
                        'rounded px-1.5 py-0.5 text-xs',
                        t.status === 'DONE' && 'bg-good/15 text-good',
                        t.status === 'FAILED' && 'bg-bad/15 text-bad',
                        (t.status === 'QUEUED' || t.status === 'RUNNING') && 'bg-accent2/15 text-accent2',
                      )}>{t.status.toLowerCase()}</span>
                      <span className="truncate text-muted">{t.profile.name}</span>
                    </p>
                    {t.outputFile && (
                      <p className="mt-1 truncate text-xs text-good">
                        {t.outputFile.filename} · {humanSize(t.outputFile.sizeBytes)}
                      </p>
                    )}
                    {t.error && <p className="mt-1 text-xs text-bad">{t.error}</p>}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>

      {showAdd && (
        <AddModelDialog
          plateId={plateId}
          onClose={() => setShowAdd(false)}
          onAdded={() => {
            setShowAdd(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

function Num({ label, value, onChange, step = 1 }: {
  label: string; value: number; onChange: (v: number) => void; step?: number;
}) {
  return (
    <div>
      <label className="label">{label}</label>
      <input type="number" step={step} className="w-full text-sm" value={value}
        onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

/** Picks meshes from the library to drop onto the plate. */
function AddModelDialog({ plateId, onClose, onAdded }: {
  plateId: string; onClose: () => void; onAdded: () => void;
}) {
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ items: ModelSummary[] }>(`/api/models?take=100${query ? `&q=${encodeURIComponent(query)}` : ''}`)
      .then((r) => setModels(r.items))
      .catch(() => setModels([]));
  }, [query]);

  const meshes = models.flatMap((m) =>
    m.files.filter((f) => f.kind === 'MESH').map((f) => ({ model: m, file: f })),
  );

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
      <div className="card w-full max-w-lg p-5">
        <h2 className="mb-3 text-lg font-semibold">Add a model to the plate</h2>
        <input className="mb-3 w-full" placeholder="Search…" value={query}
          onChange={(e) => setQuery(e.target.value)} />
        <ul className="max-h-80 space-y-1 overflow-auto">
          {meshes.map(({ model, file }) => (
            <li key={file.id}>
              <button type="button" disabled={busy}
                className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-panel2"
                onClick={async () => {
                  setBusy(true);
                  try {
                    await patch(`/api/plates/${plateId}`, { addFileIds: [file.id] });
                    onAdded();
                  } finally {
                    setBusy(false);
                  }
                }}>
                <span className="block truncate">{file.filename}</span>
                <span className="block truncate text-xs text-muted">{model.name}</span>
              </button>
            </li>
          ))}
          {meshes.length === 0 && (
            <li className="px-2 py-4 text-center text-sm text-muted">
              No meshes found. <Link href="/" className="text-accent2 hover:underline">Add one</Link>.
            </li>
          )}
        </ul>
        <div className="mt-4 flex justify-end">
          <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

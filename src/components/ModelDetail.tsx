'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import dynamicImport from 'next/dynamic';
import Link from 'next/link';
import clsx from 'clsx';
import {
  Star,
  Trash2,
  Download,
  Loader2,
  Scissors,
  Printer as PrinterIcon,
  ExternalLink,
  FileBox,
  CheckCircle2,
  XCircle,
  Clock,
  Save,
} from 'lucide-react';
import { api, post, patch, del, humanSize, humanDuration, relativeTime } from '@/lib/api-client';
import type {
  ModelDetail as ModelDetailType,
  ModelFile,
  Printer,
  SlicerProfile,
  SliceTask,
} from '@/lib/types';
import { FILE_KIND_LABEL } from '@/lib/types';
import { ResinOptions, type ResinOptionsValue } from './ResinOptions';
import { PrintIssues, type IssueReport } from './PrintIssues';

// The viewer pulls in three.js and touches WebGL; keep it off the server.
const ModelViewer = dynamicImport(
  () => import('./ModelViewer').then((m) => m.ModelViewer),
  {
    ssr: false,
    loading: () => (
      <div className="grid h-[420px] place-items-center rounded-lg border border-edge bg-panel2 text-muted">
        <Loader2 size={20} className="animate-spin" />
      </div>
    ),
  },
);

export function ModelDetail({ modelId }: { modelId: string }) {
  const router = useRouter();

  const [model, setModel] = useState<ModelDetailType | null>(null);
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [profiles, setProfiles] = useState<SlicerProfile[]>([]);
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api<ModelDetailType>(`/api/models/${modelId}`);
      setModel(data);
      setSelectedFileId((current) => {
        if (current && data.files.some((f) => f.id === current)) return current;
        return data.files.find((f) => f.kind === 'MESH')?.id ?? null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load model');
    }
  }, [modelId]);

  useEffect(() => {
    void load();
    api<Printer[]>('/api/printers').then(setPrinters).catch(() => setPrinters([]));
    api<SlicerProfile[]>('/api/profiles').then(setProfiles).catch(() => setProfiles([]));
  }, [load]);

  // Poll while anything is in flight, so slice and print state stays live
  // without a websocket.
  useEffect(() => {
    if (!model) return;
    const active =
      model.sliceTasks.some((t) => t.status === 'QUEUED' || t.status === 'RUNNING') ||
      model.jobs.some((j) =>
        ['QUEUED', 'UPLOADING', 'STARTING', 'PRINTING', 'PAUSED'].includes(j.status),
      );
    if (!active) return;

    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [model, load]);

  const flash = (message: string) => {
    setNotice(message);
    setTimeout(() => setNotice(null), 5000);
  };

  const act = async (fn: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = (await fn()) as { warnings?: string[] } | undefined;
      flash(success);
      // Print-safety notes travel with the response rather than blocking it.
      setWarnings(result?.warnings?.length ? result.warnings : []);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  if (error && !model) {
    return <p className="rounded bg-bad/10 px-4 py-3 text-sm text-bad">{error}</p>;
  }
  if (!model) {
    return (
      <div className="grid place-items-center py-24 text-muted">
        <Loader2 size={22} className="animate-spin" />
      </div>
    );
  }

  const selectedFile = model.files.find((f) => f.id === selectedFileId) ?? null;
  const meshes = model.files.filter((f) => f.kind === 'MESH');
  const sliced = model.files.filter((f) => f.kind === 'SLICED');
  const others = model.files.filter((f) => f.kind !== 'MESH' && f.kind !== 'SLICED');
  const viewable = selectedFile && /\.(stl|3mf|obj)$/i.test(selectedFile.filename);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{model.name}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
            {model.designer && <span>by {model.designer}</span>}
            <span>{model.files.length} files</span>
            {model.printCount > 0 && <span>printed {model.printCount}×</span>}
            <span>added {relativeTime(model.createdAt)}</span>
            {model.sourceUrl && (
              <a
                href={model.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-accent2 hover:underline"
              >
                Source <ExternalLink size={12} />
              </a>
            )}
          </p>
          {model.tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {model.tags.map((t) => (
                <span key={t.id} className="chip">
                  {t.name}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            className={clsx(model.favorite ? 'btn-primary' : 'btn-secondary')}
            disabled={busy}
            onClick={() =>
              act(
                () => patch(`/api/models/${modelId}`, { favorite: !model.favorite }),
                model.favorite ? 'Removed from favourites' : 'Added to favourites',
              )
            }
          >
            <Star size={14} className={model.favorite ? 'fill-current' : undefined} />
          </button>

          <button
            type="button"
            className="btn-danger"
            disabled={busy}
            onClick={async () => {
              if (!confirm(`Delete "${model.name}" and all ${model.files.length} of its files?`)) {
                return;
              }
              await act(() => del(`/api/models/${modelId}`), 'Deleted');
              router.push('/');
              router.refresh();
            }}
          >
            <Trash2 size={14} />
            Delete
          </button>
        </div>
      </header>

      {notice && (
        <p className="rounded bg-good/10 px-3 py-2 text-sm text-good">{notice}</p>
      )}
      {error && <p className="rounded bg-bad/10 px-3 py-2 text-sm text-bad">{error}</p>}

      {warnings.map((w) => (
        <p key={w} className="rounded bg-warn/10 px-3 py-2 text-sm text-warn">
          {w}
        </p>
      ))}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-4">
          {viewable && selectedFile ? (
            <ModelViewer
              key={selectedFile.id}
              fileId={selectedFile.id}
              filename={selectedFile.filename}
              modelId={model.id}
              onThumbnail={() => {
                flash('Thumbnail updated');
                router.refresh();
              }}
            />
          ) : (
            <div className="grid h-[420px] place-items-center rounded-lg border border-edge bg-panel2 text-center text-muted">
              <div>
                <FileBox size={28} className="mx-auto mb-2" />
                <p className="text-sm">
                  {selectedFile
                    ? `No 3D preview for ${selectedFile.filename}`
                    : 'Select a mesh file to preview it'}
                </p>
              </div>
            </div>
          )}

          {selectedFile && <FileStats file={selectedFile} />}

          {/* Risk detection applies to resin output only — it reads printed
              layers looking for trapped resin, islands and suction cups. */}
          {selectedFile?.kind === 'SLICED' && selectedFile.technology === 'SLA' && (
            <PrintIssues
              key={selectedFile.id}
              fileId={selectedFile.id}
              filename={selectedFile.filename}
              report={
                ((selectedFile.meta ?? {}) as { issues?: IssueReport }).issues ?? null
              }
              onChecked={load}
            />
          )}

          <SliceAndPrint
            model={model}
            printers={printers}
            profiles={profiles}
            busy={busy}
            onSlice={(fileId, profileId, autoPrintPrinterId, options) =>
              act(
                () => post('/api/slice', { fileId, profileId, autoPrintPrinterId, options }),
                'Slice queued — it will appear below when it finishes',
              )
            }
            onPrint={async (fileId, printerId) => {
              setBusy(true);
              setError(null);
              try {
                await post('/api/jobs', { printerId, fileId });
                flash('Print queued');
              } catch (err) {
                const message = err instanceof Error ? err.message : 'Could not queue print';
                // A blocked print is recoverable: show what was found and let
                // the user send it anyway, rather than leaving them stuck.
                if (/detected in it/.test(message) && confirm(`${message}\n\nSend it anyway?`)) {
                  try {
                    await post('/api/jobs', { printerId, fileId, acknowledgeRisks: true });
                    flash('Print queued despite detected risks');
                  } catch (err2) {
                    setError(err2 instanceof Error ? err2.message : 'Could not queue print');
                  }
                } else {
                  setError(message);
                }
              } finally {
                setBusy(false);
                await load();
              }
            }}
          />

          {model.sliceTasks.length > 0 && <SliceHistory tasks={model.sliceTasks} />}
        </div>

        <aside className="space-y-4">
          <FileList
            title="Models"
            files={meshes}
            selectedId={selectedFileId}
            onSelect={setSelectedFileId}
            modelId={modelId}
            onChanged={load}
          />
          {sliced.length > 0 && (
            <FileList
              title="Print-ready"
              files={sliced}
              selectedId={selectedFileId}
              onSelect={setSelectedFileId}
              modelId={modelId}
              onChanged={load}
            />
          )}
          {others.length > 0 && (
            <FileList
              title="Other files"
              files={others}
              selectedId={selectedFileId}
              onSelect={setSelectedFileId}
              modelId={modelId}
              onChanged={load}
            />
          )}
          <NotesPanel model={model} onSaved={load} />
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * The form keeps drain-hole fields flat because they render as two plain
 * inputs; the API wants them nested. Convert on the way out.
 */
function toApiOptions(o: ResinOptionsValue): Record<string, unknown> {
  const { drainHoleCount, drainHoleDiameterMm, ...rest } = o;
  return {
    ...rest,
    ...(drainHoleCount
      ? { drainHoles: { count: drainHoleCount, diameterMm: drainHoleDiameterMm ?? 3 } }
      : {}),
  };
}

function FileStats({ file }: { file: ModelFile }) {
  const stats: [string, string][] = [];
  if (file.bboxX !== null) {
    stats.push(['Size', `${file.bboxX} × ${file.bboxY} × ${file.bboxZ} mm`]);
  }
  if (file.triangles !== null) stats.push(['Triangles', file.triangles.toLocaleString()]);
  if (file.volumeMm3 !== null) {
    stats.push(['Volume', `${(file.volumeMm3 / 1000).toFixed(2)} ml`]);
  }
  stats.push(['File size', humanSize(file.sizeBytes)]);

  const meta = (file.meta ?? {}) as Record<string, unknown>;
  if (typeof meta.layerCount === 'number') stats.push(['Layers', String(meta.layerCount)]);
  if (typeof meta.estimatedSeconds === 'number') {
    stats.push(['Est. time', humanDuration(meta.estimatedSeconds)]);
  }
  if (typeof meta.estimatedTime === 'string') stats.push(['Est. time', meta.estimatedTime]);
  if (typeof meta.resinMl === 'number') stats.push(['Resin', `${meta.resinMl.toFixed(1)} ml`]);
  if (typeof meta.filamentGrams === 'number') {
    stats.push(['Filament', `${meta.filamentGrams.toFixed(1)} g`]);
  }

  if (stats.length === 0) return null;

  return (
    <div className="card p-4">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
        {stats.map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-muted">{label}</dt>
            <dd className="font-mono text-sm">{value}</dd>
          </div>
        ))}
      </dl>
      {meta.invertedNormals === true && (
        <p className="mt-3 rounded bg-warn/10 px-3 py-2 text-xs text-warn">
          This mesh has inverted normals. It will usually still slice, but check the preview
          in your slicer if the result looks hollow.
        </p>
      )}
    </div>
  );
}

function FileList({
  title,
  files,
  selectedId,
  onSelect,
  modelId,
  onChanged,
}: {
  title: string;
  files: ModelFile[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  modelId: string;
  onChanged: () => void;
}) {
  const [removing, setRemoving] = useState<string | null>(null);

  return (
    <section className="card p-3">
      <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted">
        {title}
      </h2>
      <ul className="space-y-1">
        {files.map((file) => (
          <li
            key={file.id}
            className={clsx(
              'group flex items-center gap-2 rounded px-2 py-1.5 text-sm',
              selectedId === file.id ? 'bg-panel2' : 'hover:bg-panel2/60',
            )}
          >
            <button
              type="button"
              className="min-w-0 flex-1 text-left"
              onClick={() => onSelect(file.id)}
            >
              <span className="block truncate">{file.filename}</span>
              <span className="block text-xs text-muted">
                {FILE_KIND_LABEL[file.kind]} · {humanSize(file.sizeBytes)}
              </span>
            </button>

            <a
              href={`/api/files/${file.id}?download=1`}
              className="text-muted opacity-0 transition-opacity hover:text-ink group-hover:opacity-100"
              title="Download"
              download
            >
              <Download size={14} />
            </a>

            <button
              type="button"
              className="text-muted opacity-0 transition-opacity hover:text-bad group-hover:opacity-100"
              title="Delete file"
              disabled={removing === file.id}
              onClick={async () => {
                if (!confirm(`Delete ${file.filename}?`)) return;
                setRemoving(file.id);
                try {
                  await del(`/api/models/${modelId}/files?fileId=${file.id}`);
                  onChanged();
                } catch (err) {
                  alert(err instanceof Error ? err.message : 'Could not delete');
                } finally {
                  setRemoving(null);
                }
              }}
            >
              {removing === file.id ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Trash2 size={14} />
              )}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SliceAndPrint({
  model,
  printers,
  profiles,
  busy,
  onSlice,
  onPrint,
}: {
  model: ModelDetailType;
  printers: Printer[];
  profiles: SlicerProfile[];
  busy: boolean;
  onSlice: (
    fileId: string,
    profileId: string,
    autoPrintPrinterId: string | null,
    options?: ResinOptionsValue,
  ) => void;
  onPrint: (fileId: string, printerId: string) => void;
}) {
  const meshes = model.files.filter((f) => f.kind === 'MESH');
  const sliced = model.files.filter((f) => f.kind === 'SLICED');

  const [meshId, setMeshId] = useState(meshes[0]?.id ?? '');
  const [profileId, setProfileId] = useState('');
  const [autoPrint, setAutoPrint] = useState('');
  const [resinOptions, setResinOptions] = useState<ResinOptionsValue>({});
  const [printFileId, setPrintFileId] = useState(sliced[0]?.id ?? '');
  const [printerId, setPrinterId] = useState('');

  useEffect(() => {
    if (!meshId && meshes[0]) setMeshId(meshes[0].id);
    if (!printFileId && sliced[0]) setPrintFileId(sliced[0].id);
    if (!profileId && profiles[0]) {
      setProfileId(profiles.find((p) => p.isDefault)?.id ?? profiles[0].id);
    }
  }, [meshes, sliced, profiles, meshId, printFileId, profileId]);

  const selectedProfile = profiles.find((p) => p.id === profileId);
  // Only offer auto-print on printers that match the profile's technology.
  const compatiblePrinters = printers.filter(
    (p) =>
      p.enabled &&
      (!selectedProfile ||
        (selectedProfile.technology === 'SLA') === (p.kind === 'RESIN_SDCP')),
  );

  const printable = printers.filter((p) => {
    if (!p.enabled) return false;
    const file = sliced.find((f) => f.id === printFileId);
    if (!file) return false;
    const isResinFile = /\.(ctb|cbddlp|goo|pwmx|pwma|pws)$/i.test(file.filename);
    return isResinFile === (p.kind === 'RESIN_SDCP');
  });

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <section className="card p-4">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <Scissors size={15} className="text-accent" />
          Slice
        </h2>

        {meshes.length === 0 ? (
          <p className="text-sm text-muted">No meshes on this model to slice.</p>
        ) : profiles.length === 0 ? (
          <p className="text-sm text-muted">
            No slicer profiles yet. <Link href="/profiles" className="text-accent2 hover:underline">Create one</Link>.
          </p>
        ) : (
          <div className="space-y-3">
            <div>
              <label className="label" htmlFor="slice-mesh">Mesh</label>
              <select
                id="slice-mesh"
                className="w-full"
                value={meshId}
                onChange={(e) => setMeshId(e.target.value)}
              >
                {meshes.map((f) => (
                  <option key={f.id} value={f.id}>{f.filename}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="label" htmlFor="slice-profile">Profile</label>
              <select
                id="slice-profile"
                className="w-full"
                value={profileId}
                onChange={(e) => setProfileId(e.target.value)}
              >
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.technology} → .{p.outputFormat})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="label" htmlFor="slice-auto">Then print on</label>
              <select
                id="slice-auto"
                className="w-full"
                value={autoPrint}
                onChange={(e) => setAutoPrint(e.target.value)}
              >
                <option value="">Don&apos;t print automatically</option>
                {compatiblePrinters.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>

            {selectedProfile?.technology === 'SLA' && (
              <ResinOptions value={resinOptions} onChange={setResinOptions} />
            )}

            <button
              type="button"
              className="btn-primary w-full justify-center"
              disabled={busy || !meshId || !profileId}
              onClick={() =>
                onSlice(
                  meshId,
                  profileId,
                  autoPrint || null,
                  selectedProfile?.technology === 'SLA' && Object.keys(resinOptions).length > 0
                    ? toApiOptions(resinOptions)
                    : undefined,
                )
              }
            >
              <Scissors size={14} />
              Slice
            </button>
          </div>
        )}
      </section>

      <section className="card p-4">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <PrinterIcon size={15} className="text-accent2" />
          Print
        </h2>

        {sliced.length === 0 ? (
          <p className="text-sm text-muted">
            Nothing print-ready yet. Slice a mesh, or upload a file straight from your slicer.
          </p>
        ) : printers.length === 0 ? (
          <p className="text-sm text-muted">
            No printers configured. <Link href="/printers" className="text-accent2 hover:underline">Add one</Link>.
          </p>
        ) : (
          <div className="space-y-3">
            <div>
              <label className="label" htmlFor="print-file">File</label>
              <select
                id="print-file"
                className="w-full"
                value={printFileId}
                onChange={(e) => setPrintFileId(e.target.value)}
              >
                {sliced.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.filename} ({humanSize(f.sizeBytes)})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="label" htmlFor="print-printer">Printer</label>
              <select
                id="print-printer"
                className="w-full"
                value={printerId}
                onChange={(e) => setPrinterId(e.target.value)}
              >
                <option value="">Choose a printer…</option>
                {printable.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {p.status}
                  </option>
                ))}
              </select>
              {printable.length === 0 && (
                <p className="mt-1 text-xs text-warn">
                  No enabled printer accepts this file type.
                </p>
              )}
            </div>

            <button
              type="button"
              className="btn-primary w-full justify-center"
              disabled={busy || !printFileId || !printerId}
              onClick={() => onPrint(printFileId, printerId)}
            >
              <PrinterIcon size={14} />
              Send to printer
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function SliceHistory({ tasks }: { tasks: SliceTask[] }) {
  const [openLog, setOpenLog] = useState<string | null>(null);

  return (
    <section className="card p-4">
      <h2 className="mb-3 text-sm font-semibold">Slice history</h2>
      <ul className="space-y-2">
        {tasks.map((task) => (
          <li key={task.id} className="rounded bg-panel2 p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <StatusIcon status={task.status} />
              <span className="font-medium">{task.inputFile.filename}</span>
              <span className="text-muted">→ {task.profile.name}</span>
              <span className="ml-auto text-xs text-muted">
                {relativeTime(task.finishedAt ?? task.startedAt ?? task.createdAt)}
              </span>
            </div>

            {task.outputFile && (
              <p className="mt-1 text-xs text-good">
                {task.outputFile.filename} · {humanSize(task.outputFile.sizeBytes)}
              </p>
            )}

            {task.error && (
              <p className="mt-1 whitespace-pre-wrap text-xs text-bad">{task.error}</p>
            )}

            {task.log && (
              <>
                <button
                  type="button"
                  className="mt-1 text-xs text-muted underline hover:text-ink"
                  onClick={() => setOpenLog(openLog === task.id ? null : task.id)}
                >
                  {openLog === task.id ? 'Hide' : 'Show'} slicer log
                </button>
                {openLog === task.id && (
                  <pre className="mt-2 max-h-64 overflow-auto rounded bg-bg p-2 font-mono text-[11px] text-muted">
                    {task.log}
                  </pre>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function StatusIcon({ status }: { status: SliceTask['status'] }) {
  if (status === 'RUNNING') return <Loader2 size={14} className="animate-spin text-accent2" />;
  if (status === 'QUEUED') return <Clock size={14} className="text-muted" />;
  if (status === 'DONE') return <CheckCircle2 size={14} className="text-good" />;
  return <XCircle size={14} className="text-bad" />;
}

function NotesPanel({
  model,
  onSaved,
}: {
  model: ModelDetailType;
  onSaved: () => void;
}) {
  const [notes, setNotes] = useState(model.notes ?? '');
  const [tags, setTags] = useState(model.tags.map((t) => t.name).join(', '));
  const [saving, setSaving] = useState(false);
  const dirty = notes !== (model.notes ?? '') || tags !== model.tags.map((t) => t.name).join(', ');

  return (
    <section className="card p-3">
      <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted">
        Notes &amp; tags
      </h2>

      <label className="label px-1" htmlFor="detail-tags">Tags</label>
      <input
        id="detail-tags"
        className="mb-3 w-full"
        value={tags}
        onChange={(e) => setTags(e.target.value)}
        placeholder="comma, separated"
      />

      <label className="label px-1" htmlFor="detail-notes">Notes</label>
      <textarea
        id="detail-notes"
        className="h-28 w-full resize-y"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Supports at 45°, print the base separately…"
      />

      <button
        type="button"
        className="btn-secondary mt-2 w-full justify-center"
        disabled={!dirty || saving}
        onClick={async () => {
          setSaving(true);
          try {
            await patch(`/api/models/${model.id}`, {
              notes: notes || null,
              tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
            });
            onSaved();
          } catch (err) {
            alert(err instanceof Error ? err.message : 'Could not save');
          } finally {
            setSaving(false);
          }
        }}
      >
        {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
        Save
      </button>
    </section>
  );
}

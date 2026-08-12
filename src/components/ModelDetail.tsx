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
  Printer as PrinterIcon,
  ExternalLink,
  FileBox,
  Save,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { api, post, patch, del, humanSize, humanDuration, relativeTime } from '@/lib/api-client';
import type { ModelDetail as ModelDetailType, ModelFile, Printer } from '@/lib/types';
import { FILE_KIND_LABEL } from '@/lib/types';
import { PrintIssues, type IssueReport } from './PrintIssues';
import { ImageGallery } from './ImageGallery';
import { FileDrop } from './FileDrop';
import { OpenInSlicer } from './OpenInSlicer';

// The viewer pulls in three.js and touches WebGL; keep it off the server.
const ModelViewer = dynamicImport(() => import('./ModelViewer').then((m) => m.ModelViewer), {
  ssr: false,
  loading: () => (
    <div className="grid h-[420px] place-items-center rounded-lg border border-edge bg-panel2 text-muted">
      <Loader2 size={20} className="animate-spin" />
    </div>
  ),
});

export function ModelDetail({ modelId }: { modelId: string }) {
  const router = useRouter();

  const [model, setModel] = useState<ModelDetailType | null>(null);
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAdd, setShowAdd] = useState(false);

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
    api<Printer[]>('/api/printers')
      .then(setPrinters)
      .catch(() => setPrinters([]));
  }, [load]);

  // Poll only while a print is in flight, so job state stays live without a
  // websocket.
  useEffect(() => {
    if (!model) return;
    const active = model.jobs.some((j) =>
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
      await fn();
      flash(success);
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
  // Four sections the workflow actually has: geometry, slicer projects,
  // machine-ready output, and pictures. Anything else falls through to Other.
  const meshes = model.files.filter((f) => f.kind === 'MESH');
  const plates = model.files.filter((f) => f.kind === 'PLATE');
  const sliced = model.files.filter((f) => f.kind === 'SLICED');
  const images = model.files.filter((f) => f.kind === 'IMAGE');
  const others = model.files.filter(
    (f) => !['MESH', 'PLATE', 'SLICED', 'IMAGE'].includes(f.kind),
  );
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

      {notice && <p className="rounded bg-good/10 px-3 py-2 text-sm text-good">{notice}</p>}
      {error && <p className="rounded bg-bad/10 px-3 py-2 text-sm text-bad">{error}</p>}

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

          {selectedFile && <OpenInSlicer fileId={selectedFile.id} filename={selectedFile.filename} />}

          {/* Risk detection reads printed layers, so it only applies to resin
              output — files sliced elsewhere and uploaded here included. */}
          {selectedFile?.kind === 'SLICED' && selectedFile.technology === 'SLA' && (
            <PrintIssues
              key={selectedFile.id}
              fileId={selectedFile.id}
              filename={selectedFile.filename}
              report={((selectedFile.meta ?? {}) as { issues?: IssueReport }).issues ?? null}
              onChecked={load}
            />
          )}

          <SendToPrinter
            sliced={sliced}
            printers={printers}
            busy={busy}
            onPrint={async (fileId, printerId) => {
              setBusy(true);
              setError(null);
              try {
                await post('/api/jobs', { printerId, fileId });
                flash('Print queued');
              } catch (err) {
                const message = err instanceof Error ? err.message : 'Could not queue print';
                // A blocked print is recoverable: show what was found and let
                // the user send it anyway rather than leaving them stuck.
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
        </div>

        <aside className="space-y-4">
          <section className="card p-3">
            <button
              type="button"
              className="mb-2 flex w-full items-center gap-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted hover:text-ink"
              onClick={() => setShowAdd((s) => !s)}
            >
              {showAdd ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              Add files
            </button>
            {showAdd && (
              <FileDrop
                modelId={modelId}
                compact
                onUploaded={(n) => {
                  if (n > 0) flash(`Added ${n} file${n === 1 ? '' : 's'}`);
                  void load();
                  router.refresh();
                }}
              />
            )}
          </section>

          <FileList
            title="Models (STL)"
            files={meshes}
            selectedId={selectedFileId}
            onSelect={setSelectedFileId}
            modelId={modelId}
            onChanged={load}
            emptyHint="STL, OBJ, STEP or plain 3MF geometry."
          />
          <FileList
            title="Build plates"
            files={plates}
            selectedId={selectedFileId}
            onSelect={setSelectedFileId}
            modelId={modelId}
            onChanged={load}
            emptyHint="Slicer project files — a Bambu or Prusa .3mf, or a Lychee .lys — holding an arrangement and its settings."
          />
          <FileList
            title="Sliced"
            files={sliced}
            selectedId={selectedFileId}
            onSelect={setSelectedFileId}
            modelId={modelId}
            onChanged={load}
            emptyHint="Machine-ready output (.ctb, .goo, .gcode.3mf). Upload from your slicer and it can go straight to a printer."
          />
          <ImageGallery
            modelId={modelId}
            images={images}
            coverFileId={model.coverFileId ?? null}
            onChanged={() => {
              void load();
              router.refresh();
            }}
          />
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
          This mesh has inverted normals. Most slicers cope, but check the preview if the
          result looks hollow.
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
  emptyHint,
}: {
  title: string;
  files: ModelFile[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  modelId: string;
  onChanged: () => void;
  emptyHint?: string;
}) {
  const [removing, setRemoving] = useState<string | null>(null);

  if (files.length === 0 && !emptyHint) return null;

  return (
    <section className="card p-3">
      <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted">
        {title}
      </h2>
      {files.length === 0 ? (
        <p className="px-2 py-1.5 text-xs text-muted">{emptyHint}</p>
      ) : (
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
      )}
    </section>
  );
}

/** Sends an already-sliced file to a printer. Nothing is sliced here any more. */
function SendToPrinter({
  sliced,
  printers,
  busy,
  onPrint,
}: {
  sliced: ModelFile[];
  printers: Printer[];
  busy: boolean;
  onPrint: (fileId: string, printerId: string) => void;
}) {
  const [fileId, setFileId] = useState('');
  const [printerId, setPrinterId] = useState('');

  useEffect(() => {
    if (!fileId && sliced[0]) setFileId(sliced[0].id);
  }, [sliced, fileId]);

  // Only offer printers that can actually read the chosen file.
  const compatible = printers.filter((p) => {
    if (!p.enabled) return false;
    const file = sliced.find((f) => f.id === fileId);
    if (!file) return false;
    const isResin = /\.(ctb|cbddlp|goo|pwmx|pwma|pws)$/i.test(file.filename);
    return isResin === (p.kind === 'RESIN_SDCP');
  });

  return (
    <section className="card p-4">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <PrinterIcon size={15} className="text-accent2" />
        Send to printer
      </h2>

      {sliced.length === 0 ? (
        <p className="text-sm text-muted">
          No print-ready files yet. Slice this model in ChiTuBox, Bambu Studio or Lychee, then
          upload the result here and it can go straight to a printer.
        </p>
      ) : printers.length === 0 ? (
        <p className="text-sm text-muted">
          No printers configured.{' '}
          <Link href="/printers" className="text-accent2 hover:underline">
            Add one
          </Link>
          .
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="send-file">
              File
            </label>
            <select
              id="send-file"
              className="w-full"
              value={fileId}
              onChange={(e) => setFileId(e.target.value)}
            >
              {sliced.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.filename} ({humanSize(f.sizeBytes)})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label" htmlFor="send-printer">
              Printer
            </label>
            <select
              id="send-printer"
              className="w-full"
              value={printerId}
              onChange={(e) => setPrinterId(e.target.value)}
            >
              <option value="">Choose a printer…</option>
              {compatible.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {p.status}
                </option>
              ))}
            </select>
            {compatible.length === 0 && (
              <p className="mt-1 text-xs text-warn">No enabled printer accepts this file type.</p>
            )}
          </div>

          <div className="sm:col-span-2">
            <button
              type="button"
              className="btn-primary w-full justify-center"
              disabled={busy || !fileId || !printerId}
              onClick={() => onPrint(fileId, printerId)}
            >
              <PrinterIcon size={14} />
              Send to printer
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function NotesPanel({ model, onSaved }: { model: ModelDetailType; onSaved: () => void }) {
  const [notes, setNotes] = useState(model.notes ?? '');
  const [tags, setTags] = useState(model.tags.map((t) => t.name).join(', '));
  const [saving, setSaving] = useState(false);
  const dirty = notes !== (model.notes ?? '') || tags !== model.tags.map((t) => t.name).join(', ');

  return (
    <section className="card p-3">
      <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted">
        Notes &amp; tags
      </h2>

      <label className="label px-1" htmlFor="detail-tags">
        Tags
      </label>
      <input
        id="detail-tags"
        className="mb-3 w-full"
        value={tags}
        onChange={(e) => setTags(e.target.value)}
        placeholder="comma, separated"
      />

      <label className="label px-1" htmlFor="detail-notes">
        Notes
      </label>
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
              tags: tags
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean),
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

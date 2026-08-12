'use client';

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Upload, X, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import clsx from 'clsx';
import { post, humanSize } from '@/lib/api-client';
import { putFile } from './FileDrop';
import type { ModelSummary } from '@/lib/types';

interface FileProgress {
  name: string;
  size: number;
  sent: number;
  state: 'waiting' | 'uploading' | 'done' | 'error';
  error?: string;
}

/**
 * Creates a model and uploads its files.
 *
 * Files go up one at a time as raw PUT bodies rather than one big multipart
 * form: the server streams each straight to disk, and XHR gives us real upload
 * progress, which fetch still cannot do.
 */
export function Uploader({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState('');
  const [designer, setDesigner] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [tagText, setTagText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<FileProgress[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const addFiles = useCallback(
    (incoming: FileList | File[]) => {
      const list = Array.from(incoming);
      setFiles((prev) => {
        const seen = new Set(prev.map((f) => `${f.name}:${f.size}`));
        return [...prev, ...list.filter((f) => !seen.has(`${f.name}:${f.size}`))];
      });
      // Default the model name to the first mesh dropped in.
      setName((current) => {
        if (current) return current;
        const mesh = list.find((f) => /\.(stl|3mf|obj|step|stp)$/i.test(f.name));
        const source = mesh ?? list[0];
        return source ? source.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ') : current;
      });
    },
    [],
  );

  const upload = async () => {
    if (!name.trim()) {
      setError('Give the model a name');
      return;
    }
    if (files.length === 0) {
      setError('Add at least one file');
      return;
    }

    setBusy(true);
    setError(null);
    setProgress(files.map((f) => ({ name: f.name, size: f.size, sent: 0, state: 'waiting' })));

    try {
      const tags = tagText
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

      const model = await post<ModelSummary>('/api/models', {
        name: name.trim(),
        designer: designer.trim() || undefined,
        sourceUrl: sourceUrl.trim() || undefined,
        tags: tags.length ? tags : undefined,
      });

      for (let i = 0; i < files.length; i++) {
        setProgress((p) => update(p, i, { state: 'uploading' }));
        try {
          await putFile(model.id, files[i], (sent) =>
            setProgress((p) => update(p, i, { sent })),
          );
          setProgress((p) => update(p, i, { state: 'done', sent: files[i].size }));
        } catch (err) {
          setProgress((p) =>
            update(p, i, {
              state: 'error',
              error: err instanceof Error ? err.message : 'Upload failed',
            }),
          );
        }
      }

      // Navigate regardless: the model exists and partial uploads are visible on
      // its page, which is more useful than trapping the user in this dialog.
      router.push(`/models/${model.id}`);
      router.refresh();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
      <div className="card w-full max-w-2xl max-h-[90vh] overflow-y-auto p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Add to library</h2>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
            <X size={16} />
          </button>
        </div>

        <div
          className={clsx(
            'mb-4 rounded-lg border-2 border-dashed p-6 text-center transition-colors',
            dragging ? 'border-accent bg-accent/5' : 'border-edge',
          )}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
          }}
        >
          <Upload size={24} className="mx-auto mb-2 text-muted" />
          <p className="text-sm text-muted">
            Drop STL, 3MF, OBJ, sliced files, images or notes here
          </p>
          <button
            type="button"
            className="btn-secondary mt-3"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
          >
            Choose files
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </div>

        {files.length > 0 && (
          <ul className="mb-4 space-y-1">
            {files.map((f, i) => {
              const p = progress[i];
              const pct = p && p.size > 0 ? Math.round((p.sent / p.size) * 100) : 0;
              return (
                <li
                  key={`${f.name}-${f.size}`}
                  className="flex items-center gap-2 rounded bg-panel2 px-3 py-2 text-sm"
                >
                  <span className="flex-1 truncate">{f.name}</span>
                  <span className="text-xs text-muted">{humanSize(f.size)}</span>

                  {p?.state === 'uploading' && (
                    <span className="flex items-center gap-1.5 text-xs text-accent2">
                      <Loader2 size={13} className="animate-spin" />
                      {pct}%
                    </span>
                  )}
                  {p?.state === 'done' && <CheckCircle2 size={14} className="text-good" />}
                  {p?.state === 'error' && (
                    <span title={p.error}>
                      <AlertCircle size={14} className="text-bad" />
                    </span>
                  )}
                  {!busy && (
                    <button
                      type="button"
                      className="text-muted hover:text-bad"
                      onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                      aria-label={`Remove ${f.name}`}
                    >
                      <X size={14} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="label" htmlFor="up-name">
              Name
            </label>
            <input
              id="up-name"
              className="w-full"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Articulated dragon"
              disabled={busy}
            />
          </div>
          <div>
            <label className="label" htmlFor="up-designer">
              Designer
            </label>
            <input
              id="up-designer"
              className="w-full"
              value={designer}
              onChange={(e) => setDesigner(e.target.value)}
              placeholder="Optional"
              disabled={busy}
            />
          </div>
          <div>
            <label className="label" htmlFor="up-tags">
              Tags
            </label>
            <input
              id="up-tags"
              className="w-full"
              value={tagText}
              onChange={(e) => setTagText(e.target.value)}
              placeholder="miniature, dragon"
              disabled={busy}
            />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="up-source">
              Source URL
            </label>
            <input
              id="up-source"
              className="w-full"
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              placeholder="https://…"
              disabled={busy}
            />
          </div>
        </div>

        {error && (
          <p className="mt-3 rounded bg-bad/10 px-3 py-2 text-sm text-bad">{error}</p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={upload} disabled={busy}>
            {busy && <Loader2 size={14} className="animate-spin" />}
            {busy ? 'Uploading…' : `Upload ${files.length || ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function update(list: FileProgress[], index: number, patch: Partial<FileProgress>) {
  return list.map((p, i) => (i === index ? { ...p, ...patch } : p));
}


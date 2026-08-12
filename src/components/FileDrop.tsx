'use client';

import { useCallback, useRef, useState } from 'react';
import clsx from 'clsx';
import { Upload, X, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { humanSize } from '@/lib/api-client';

interface FileProgress {
  name: string;
  size: number;
  sent: number;
  state: 'waiting' | 'uploading' | 'done' | 'error';
  error?: string;
}

/**
 * Picks files and uploads them to a model.
 *
 * Shared by "create a model" and "add to this model" so both behave the same:
 * one raw PUT per file, streamed straight to disk on the server, with real
 * progress. Uses XHR because fetch still has no upload progress event, and a
 * 300 MB STL with no feedback looks broken.
 */
export function FileDrop({
  modelId,
  onUploaded,
  compact,
}: {
  /** When absent, files are only staged — the caller uploads after creating. */
  modelId?: string;
  onUploaded?: (count: number) => void;
  compact?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<FileProgress[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);

  const addFiles = useCallback((incoming: FileList | File[]) => {
    const list = Array.from(incoming);
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => `${f.name}:${f.size}`));
      return [...prev, ...list.filter((f) => !seen.has(`${f.name}:${f.size}`))];
    });
  }, []);

  const upload = async () => {
    if (!modelId || files.length === 0) return;
    setBusy(true);
    setProgress(files.map((f) => ({ name: f.name, size: f.size, sent: 0, state: 'waiting' })));

    let succeeded = 0;
    for (let i = 0; i < files.length; i++) {
      setProgress((p) => update(p, i, { state: 'uploading' }));
      try {
        await putFile(modelId, files[i], (sent) => setProgress((p) => update(p, i, { sent })));
        setProgress((p) => update(p, i, { state: 'done', sent: files[i].size }));
        succeeded++;
      } catch (err) {
        setProgress((p) =>
          update(p, i, {
            state: 'error',
            error: err instanceof Error ? err.message : 'Upload failed',
          }),
        );
      }
    }

    setBusy(false);
    // Keep failures on screen; clear the list only when everything landed.
    if (succeeded === files.length) {
      setFiles([]);
      setProgress([]);
    }
    onUploaded?.(succeeded);
  };

  return (
    <div>
      <div
        className={clsx(
          'rounded-lg border-2 border-dashed text-center transition-colors',
          compact ? 'p-3' : 'p-6',
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
        {!compact && <Upload size={24} className="mx-auto mb-2 text-muted" />}
        <p className="text-xs text-muted">
          Drop models, slicer projects, sliced files, images or notes here
        </p>
        <button
          type="button"
          className="btn-secondary mt-2"
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
        <ul className="mt-2 space-y-1">
          {files.map((f, i) => {
            const p = progress[i];
            const pct = p && p.size > 0 ? Math.round((p.sent / p.size) * 100) : 0;
            return (
              <li
                key={`${f.name}-${f.size}`}
                className="flex items-center gap-2 rounded bg-panel2 px-2 py-1.5 text-xs"
              >
                <span className="flex-1 truncate">{f.name}</span>
                <span className="text-muted">{humanSize(f.size)}</span>
                {p?.state === 'uploading' && (
                  <span className="flex items-center gap-1 text-accent2">
                    <Loader2 size={12} className="animate-spin" />
                    {pct}%
                  </span>
                )}
                {p?.state === 'done' && <CheckCircle2 size={13} className="text-good" />}
                {p?.state === 'error' && (
                  <span title={p.error}>
                    <AlertCircle size={13} className="text-bad" />
                  </span>
                )}
                {!busy && (
                  <button
                    type="button"
                    className="text-muted hover:text-bad"
                    onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                    aria-label={`Remove ${f.name}`}
                  >
                    <X size={12} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {modelId && files.length > 0 && (
        <button
          type="button"
          className="btn-primary mt-2 w-full justify-center"
          onClick={upload}
          disabled={busy}
        >
          {busy && <Loader2 size={14} className="animate-spin" />}
          {busy ? 'Uploading…' : `Upload ${files.length} file${files.length === 1 ? '' : 's'}`}
        </button>
      )}
    </div>
  );
}

/** Exposed so the create-model flow can upload its staged files. */
export function putFile(
  modelId: string,
  file: File,
  onProgress: (sent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/models/${modelId}/files?filename=${encodeURIComponent(file.name)}`, true);
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        let message = `${xhr.status} ${xhr.statusText}`;
        try {
          message = JSON.parse(xhr.responseText).error ?? message;
        } catch {
          /* keep the status line */
        }
        reject(new Error(message));
      }
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.send(file);
  });
}

function update(list: FileProgress[], index: number, patch: Partial<FileProgress>) {
  return list.map((p, i) => (i === index ? { ...p, ...patch } : p));
}

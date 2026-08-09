'use client';

import { useState } from 'react';
import clsx from 'clsx';
import { Star, Loader2, X } from 'lucide-react';
import { api } from '@/lib/api-client';
import type { ModelFile } from '@/lib/types';

/**
 * Renders and part-shot gallery.
 *
 * Cover selection points the model's thumbnail at an uploaded image rather than
 * copying it, so the library tile updates immediately and there is only ever one
 * copy of the bytes.
 */
export function ImageGallery({
  modelId,
  images,
  coverFileId,
  onChanged,
}: {
  modelId: string;
  images: ModelFile[];
  /** Resolved server-side; the client never sees storage paths. */
  coverFileId: string | null;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<ModelFile | null>(null);

  if (images.length === 0) return null;

  const setCover = async (file: ModelFile | null) => {
    setBusy(file?.id ?? 'clear');
    setError(null);
    try {
      await api(`/api/models/${modelId}/cover`, {
        method: 'PUT',
        body: JSON.stringify({ fileId: file?.id ?? null }),
      });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set the cover');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="card p-3">
      <div className="mb-2 flex items-center justify-between px-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
          Images ({images.length})
        </h2>
        {coverFileId && (
          <button
            type="button"
            className="text-xs text-muted underline hover:text-ink"
            onClick={() => setCover(null)}
            disabled={busy !== null}
          >
            Clear cover
          </button>
        )}
      </div>

      {error && <p className="mb-2 rounded bg-bad/10 px-2 py-1.5 text-xs text-bad">{error}</p>}

      <div className="grid grid-cols-3 gap-2">
        {images.map((img) => {
          const isCover = coverFileId === img.id;
          return (
            <div key={img.id} className="group relative">
              <button
                type="button"
                className={clsx(
                  'block w-full overflow-hidden rounded border',
                  isCover ? 'border-accent' : 'border-edge hover:border-muted',
                )}
                onClick={() => setLightbox(img)}
                title={img.filename}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/files/${img.id}`}
                  alt={img.filename}
                  className="aspect-square w-full object-cover"
                  loading="lazy"
                />
              </button>

              <button
                type="button"
                className={clsx(
                  'absolute right-1 top-1 rounded bg-bg/80 p-1 transition-opacity',
                  isCover ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                )}
                title={isCover ? 'This is the cover' : 'Use as cover'}
                onClick={() => setCover(img)}
                disabled={busy !== null || isCover}
              >
                {busy === img.id ? (
                  <Loader2 size={12} className="animate-spin text-muted" />
                ) : (
                  <Star
                    size={12}
                    className={isCover ? 'fill-accent text-accent' : 'text-muted'}
                  />
                )}
              </button>
            </div>
          );
        })}
      </div>

      {lightbox && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-6"
          onClick={() => setLightbox(null)}
        >
          <button type="button" className="btn-ghost absolute right-4 top-4 text-ink">
            <X size={20} />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/files/${lightbox.id}`}
            alt={lightbox.filename}
            className="max-h-full max-w-full rounded object-contain"
          />
          <p className="absolute bottom-4 text-sm text-muted">{lightbox.filename}</p>
        </div>
      )}
    </section>
  );
}

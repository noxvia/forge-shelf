'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { Search, Plus, Star, Layers, Printer as PrinterIcon, Loader2 } from 'lucide-react';
import { api, humanSize } from '@/lib/api-client';
import type { ModelSummary, Tag } from '@/lib/types';
import { Uploader } from './Uploader';

interface ListResponse {
  items: ModelSummary[];
  total: number;
}

export function LibraryGrid() {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  const [onlyPrintable, setOnlyPrintable] = useState(false);
  const [sort, setSort] = useState<'recent' | 'name' | 'prints'>('recent');

  const [data, setData] = useState<ListResponse | null>(null);
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showUploader, setShowUploader] = useState(false);

  // Debounce the search box so typing doesn't fire a query per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 250);
    return () => clearTimeout(t);
  }, [query]);

  const url = useMemo(() => {
    const params = new URLSearchParams({ sort, take: '120' });
    if (debounced.trim()) params.set('q', debounced.trim());
    if (activeTag) params.set('tag', activeTag);
    if (onlyFavorites) params.set('favorite', 'true');
    if (onlyPrintable) params.set('printable', 'true');
    return `/api/models?${params}`;
  }, [debounced, activeTag, onlyFavorites, onlyPrintable, sort]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<ListResponse>(url)
      .then((res) => {
        if (!cancelled) {
          setData(res);
          setError(null);
        }
      })
      .catch((err: Error) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [url]);

  useEffect(() => {
    api<Tag[]>('/api/tags')
      .then(setTags)
      .catch(() => setTags([]));
  }, [showUploader]);

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[240px] flex-1">
          <Search
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
          />
          <input
            className="w-full pl-9"
            placeholder="Search names, designers, filenames, tags…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <select
          className="text-sm"
          value={sort}
          onChange={(e) => setSort(e.target.value as typeof sort)}
          aria-label="Sort models"
        >
          <option value="recent">Newest first</option>
          <option value="name">Name A–Z</option>
          <option value="prints">Most printed</option>
        </select>

        <button
          type="button"
          className={clsx(onlyFavorites ? 'btn-primary' : 'btn-secondary')}
          onClick={() => setOnlyFavorites((v) => !v)}
        >
          <Star size={14} />
          Favourites
        </button>

        <button
          type="button"
          className={clsx(onlyPrintable ? 'btn-primary' : 'btn-secondary')}
          onClick={() => setOnlyPrintable((v) => !v)}
          title="Only models that already have a machine-ready file"
        >
          <PrinterIcon size={14} />
          Print-ready
        </button>

        <button type="button" className="btn-primary" onClick={() => setShowUploader(true)}>
          <Plus size={15} />
          Add model
        </button>
      </div>

      {tags.length > 0 && (
        <div className="mb-5 flex flex-wrap gap-1.5">
          <button
            type="button"
            className={clsx('chip', !activeTag && 'border-accent text-accent')}
            onClick={() => setActiveTag(null)}
          >
            All
          </button>
          {tags.map((tag) => (
            <button
              key={tag.id}
              type="button"
              className={clsx('chip', activeTag === tag.slug && 'border-accent text-accent')}
              onClick={() => setActiveTag(activeTag === tag.slug ? null : tag.slug)}
              style={
                tag.color && activeTag !== tag.slug
                  ? { borderColor: `${tag.color}55` }
                  : undefined
              }
            >
              {tag.name}
              {tag.count !== undefined && <span className="text-muted">{tag.count}</span>}
            </button>
          ))}
        </div>
      )}

      {error && (
        <p className="mb-4 rounded bg-bad/10 px-3 py-2 text-sm text-bad">{error}</p>
      )}

      {loading && !data && (
        <div className="grid place-items-center py-24 text-muted">
          <Loader2 size={22} className="animate-spin" />
        </div>
      )}

      {data && data.items.length === 0 && (
        <div className="card grid place-items-center py-20 text-center">
          <Layers size={30} className="mb-3 text-muted" />
          <p className="font-medium">
            {debounced || activeTag || onlyFavorites || onlyPrintable
              ? 'Nothing matches those filters'
              : 'Your library is empty'}
          </p>
          <p className="mt-1 text-sm text-muted">
            {debounced || activeTag || onlyFavorites || onlyPrintable
              ? 'Try clearing a filter.'
              : 'Add your first model to get started.'}
          </p>
        </div>
      )}

      {data && data.items.length > 0 && (
        <>
          <p className="mb-3 text-xs text-muted">
            {data.total} model{data.total === 1 ? '' : 's'}
            {loading && ' · refreshing…'}
          </p>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {data.items.map((model) => (
              <ModelCard key={model.id} model={model} />
            ))}
          </div>
        </>
      )}

      {showUploader && <Uploader onClose={() => setShowUploader(false)} />}
    </div>
  );
}

function ModelCard({ model }: { model: ModelSummary }) {
  const meshCount = model.files.filter((f) => f.kind === 'MESH').length;
  const printable = model.files.filter((f) => f.kind === 'SLICED');
  const totalBytes = model.files.reduce((sum, f) => sum + Number(f.sizeBytes), 0);

  return (
    <Link
      href={`/models/${model.id}`}
      className="card group overflow-hidden transition-colors hover:border-muted"
    >
      <div className="relative aspect-square bg-panel2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/api/thumbs/${model.id}`}
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
        />
        {!model.thumbnailPath && (
          <div className="absolute inset-0 grid place-items-center text-muted">
            <Layers size={26} />
          </div>
        )}
        {model.favorite && (
          <Star size={15} className="absolute right-2 top-2 fill-accent text-accent" />
        )}
        {printable.length > 0 && (
          <span className="absolute bottom-2 left-2 rounded bg-good/20 px-1.5 py-0.5 text-[10px] font-medium text-good">
            {printable.length} ready
          </span>
        )}
      </div>

      <div className="p-2.5">
        <p className="truncate text-sm font-medium group-hover:text-accent">{model.name}</p>
        <p className="mt-0.5 truncate text-xs text-muted">
          {meshCount} file{meshCount === 1 ? '' : 's'} · {humanSize(totalBytes)}
          {model.printCount > 0 && ` · printed ${model.printCount}×`}
        </p>
        {model.tags.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {model.tags.slice(0, 3).map((t) => (
              <span
                key={t.id}
                className="rounded px-1.5 py-0.5 text-[10px] text-muted"
                style={{ backgroundColor: `${t.color ?? '#8b949e'}22` }}
              >
                {t.name}
              </span>
            ))}
          </div>
        )}
      </div>
    </Link>
  );
}

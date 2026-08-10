'use client';

import { useEffect, useState } from 'react';
import { ExternalLink, Copy, Download, Check, Info } from 'lucide-react';
import { api } from '@/lib/api-client';

interface OpenInfo {
  hostPath: string | null;
  apps: { key: string; label: string; uri: string }[];
  reason: string | null;
}

/**
 * Hands a file off to a desktop slicer.
 *
 * A plain link cannot start a local application, so the buttons use a
 * forgeshelf:// scheme that a small installer registers on the workstation.
 * Nothing here breaks if that isn't installed — the browser simply does
 * nothing, which is why "Copy path" and "Download" sit alongside as routes that
 * always work.
 */
export function OpenInSlicer({ fileId, filename }: { fileId: string; filename: string }) {
  const [info, setInfo] = useState<OpenInfo | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<OpenInfo>(`/api/files/${fileId}/open-in`)
      .then((d) => !cancelled && setInfo(d))
      .catch(() => !cancelled && setInfo(null));
    return () => {
      cancelled = true;
    };
  }, [fileId]);

  const copyPath = async () => {
    if (!info?.hostPath) return;
    try {
      await navigator.clipboard.writeText(info.hostPath);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard is blocked outside a secure context; the path is shown below
      // so it can still be selected by hand.
    }
  };

  return (
    <section className="card p-4">
      <h2 className="mb-3 text-sm font-semibold">Open elsewhere</h2>

      <div className="flex flex-wrap gap-2">
        {info?.apps.map((app) => (
          <a key={app.key} href={app.uri} className="btn-secondary">
            <ExternalLink size={13} />
            {app.label}
          </a>
        ))}

        {info?.hostPath && (
          <button type="button" className="btn-secondary" onClick={copyPath}>
            {copied ? <Check size={13} className="text-good" /> : <Copy size={13} />}
            {copied ? 'Copied' : 'Copy path'}
          </button>
        )}

        <a href={`/api/files/${fileId}?download=1`} className="btn-secondary" download>
          <Download size={13} />
          Download
        </a>
      </div>

      {info?.hostPath && (
        <p className="mt-2 break-all font-mono text-[11px] text-muted">{info.hostPath}</p>
      )}

      {info?.reason && (
        <p className="mt-2 flex items-start gap-2 rounded bg-panel2 px-2 py-1.5 text-xs text-muted">
          <Info size={13} className="mt-0.5 shrink-0" />
          {info.reason}
        </p>
      )}

      {info?.apps.length ? (
        <p className="mt-2 text-xs text-muted">
          The app buttons need the one-time handler installed —{' '}
          <a href="/api/system/open-in-installer" className="text-accent2 hover:underline" download>
            download it
          </a>{' '}
          and run it on this machine. Copy path and Download always work.
        </p>
      ) : null}
    </section>
  );
}

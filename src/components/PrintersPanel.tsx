'use client';

import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import {
  Plus,
  Radar,
  Loader2,
  RefreshCw,
  Trash2,
  Pause,
  Play,
  Square,
  X,
  Info,
} from 'lucide-react';
import { api, post, patch, del, humanDuration, relativeTime } from '@/lib/api-client';
import type { Printer, PrinterKind, Discovered } from '@/lib/types';
import { PRINTER_KIND_LABEL } from '@/lib/types';

export function PrintersPanel() {
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [prefill, setPrefill] = useState<Partial<Discovered> | null>(null);
  const [scanning, setScanning] = useState(false);
  const [found, setFound] = useState<{ results: Discovered[]; hint: string | null } | null>(null);

  const load = useCallback(async () => {
    try {
      setPrinters(await api<Printer[]>('/api/printers'));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load printers');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // The worker refreshes status on its own cadence; mirror it here.
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const scan = async () => {
    setScanning(true);
    setFound(null);
    try {
      setFound(await post('/api/printers/discover', {}));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Discovery failed');
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Printers</h1>
        <div className="flex gap-2">
          <button type="button" className="btn-secondary" onClick={scan} disabled={scanning}>
            {scanning ? <Loader2 size={14} className="animate-spin" /> : <Radar size={14} />}
            Scan network
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              setPrefill(null);
              setShowAdd(true);
            }}
          >
            <Plus size={15} />
            Add printer
          </button>
        </div>
      </div>

      {error && <p className="rounded bg-bad/10 px-3 py-2 text-sm text-bad">{error}</p>}

      {found && (
        <div className="card p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Discovery results</h2>
            <button type="button" className="btn-ghost" onClick={() => setFound(null)}>
              <X size={14} />
            </button>
          </div>

          {found.hint && (
            <p className="flex items-start gap-2 rounded bg-panel2 px-3 py-2 text-xs text-muted">
              <Info size={14} className="mt-0.5 shrink-0" />
              {found.hint}
            </p>
          )}

          <ul className="space-y-2">
            {found.results.map((d) => (
              <li
                key={`${d.kind}-${d.host}`}
                className="flex flex-wrap items-center gap-3 rounded bg-panel2 px-3 py-2 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{d.name}</p>
                  <p className="text-xs text-muted">
                    {d.host} · {PRINTER_KIND_LABEL[d.kind]}
                    {d.firmware && ` · fw ${d.firmware}`}
                  </p>
                </div>
                {d.alreadyAdded ? (
                  <span className="text-xs text-muted">Already added</span>
                ) : (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => {
                      setPrefill(d);
                      setShowAdd(true);
                    }}
                  >
                    Add
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {loading && printers.length === 0 && (
        <div className="grid place-items-center py-20 text-muted">
          <Loader2 size={22} className="animate-spin" />
        </div>
      )}

      {!loading && printers.length === 0 && (
        <div className="card grid place-items-center py-16 text-center">
          <p className="font-medium">No printers yet</p>
          <p className="mt-1 max-w-md text-sm text-muted">
            Scan the network, or add one by IP address. Bambu printers need their serial
            number and LAN access code; SDCP resin printers just need an IP.
          </p>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {printers.map((printer) => (
          <PrinterCard key={printer.id} printer={printer} onChanged={load} />
        ))}
      </div>

      {showAdd && (
        <PrinterForm
          prefill={prefill}
          onClose={() => setShowAdd(false)}
          onSaved={() => {
            setShowAdd(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

const STATUS_STYLES: Record<string, string> = {
  idle: 'bg-good/15 text-good',
  printing: 'bg-accent2/15 text-accent2',
  paused: 'bg-warn/15 text-warn',
  finished: 'bg-good/15 text-good',
  error: 'bg-bad/15 text-bad',
  offline: 'bg-muted/15 text-muted',
  unknown: 'bg-muted/15 text-muted',
};

function PrinterCard({ printer, onChanged }: { printer: Printer; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status = printer.statusJson;

  const control = async (action: 'refresh' | 'pause' | 'resume' | 'cancel') => {
    if (action === 'cancel' && !confirm(`Stop the current print on ${printer.name}?`)) return;
    setBusy(action);
    setError(null);
    try {
      await post(`/api/printers/${printer.id}/control`, { action });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Command failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={clsx('card p-4', !printer.enabled && 'opacity-60')}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium">{printer.name}</p>
          <p className="truncate text-xs text-muted">
            {PRINTER_KIND_LABEL[printer.kind]} · {printer.host}
          </p>
        </div>
        <span
          className={clsx(
            'shrink-0 rounded px-2 py-0.5 text-xs font-medium',
            STATUS_STYLES[printer.status] ?? STATUS_STYLES.unknown,
          )}
        >
          {printer.status}
        </span>
      </div>

      {status?.state === 'printing' && (
        <div className="mb-3">
          <div className="mb-1 flex justify-between text-xs text-muted">
            <span className="truncate">{status.jobName ?? 'Printing'}</span>
            <span>{status.progress ?? 0}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-panel2">
            <div
              className="h-full bg-accent2 transition-all"
              style={{ width: `${status.progress ?? 0}%` }}
            />
          </div>
          <p className="mt-1 text-xs text-muted">
            {status.layerCurrent !== null && status.layerTotal !== null && (
              <>layer {status.layerCurrent}/{status.layerTotal} · </>
            )}
            {humanDuration(status.etaSeconds)} left
          </p>
        </div>
      )}

      <dl className="mb-3 grid grid-cols-3 gap-2 text-xs">
        {status?.nozzleTemp != null && <Temp label="Nozzle" value={status.nozzleTemp} />}
        {status?.bedTemp != null && <Temp label="Bed" value={status.bedTemp} />}
        {status?.chamberTemp != null && <Temp label="Chamber" value={status.chamberTemp} />}
        {status?.uvLedTemp != null && <Temp label="UV LED" value={status.uvLedTemp} />}
      </dl>

      {printer.lastError && (
        <p className="mb-3 rounded bg-bad/10 px-2 py-1.5 text-xs text-bad">{printer.lastError}</p>
      )}
      {error && <p className="mb-3 rounded bg-bad/10 px-2 py-1.5 text-xs text-bad">{error}</p>}

      <p className="mb-3 text-xs text-muted">Last seen {relativeTime(printer.lastSeenAt)}</p>

      <div className="flex flex-wrap gap-1.5">
        <button type="button" className="btn-secondary" onClick={() => control('refresh')} disabled={Boolean(busy)}>
          {busy === 'refresh' ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
        </button>

        {status?.state === 'printing' && (
          <button type="button" className="btn-secondary" onClick={() => control('pause')} disabled={Boolean(busy)}>
            <Pause size={13} /> Pause
          </button>
        )}
        {status?.state === 'paused' && (
          <button type="button" className="btn-secondary" onClick={() => control('resume')} disabled={Boolean(busy)}>
            <Play size={13} /> Resume
          </button>
        )}
        {(status?.state === 'printing' || status?.state === 'paused') && (
          <button type="button" className="btn-danger" onClick={() => control('cancel')} disabled={Boolean(busy)}>
            <Square size={13} /> Stop
          </button>
        )}

        <button
          type="button"
          className="btn-ghost ml-auto"
          onClick={async () => {
            await patch(`/api/printers/${printer.id}`, { enabled: !printer.enabled });
            onChanged();
          }}
        >
          {printer.enabled ? 'Disable' : 'Enable'}
        </button>

        <button
          type="button"
          className="btn-ghost text-bad"
          onClick={async () => {
            if (!confirm(`Remove ${printer.name}?`)) return;
            try {
              await del(`/api/printers/${printer.id}`);
              onChanged();
            } catch (err) {
              setError(err instanceof Error ? err.message : 'Could not remove');
            }
          }}
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
}

function Temp({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className="font-mono">{value.toFixed(0)}°C</dd>
    </div>
  );
}

function PrinterForm({
  prefill,
  onClose,
  onSaved,
}: {
  prefill: Partial<Discovered> | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState<PrinterKind>(prefill?.kind ?? 'FDM_BAMBU');
  const [name, setName] = useState(prefill?.name ?? '');
  const [host, setHost] = useState(prefill?.host ?? '');
  const [serial, setSerial] = useState(prefill?.serial ?? '');
  const [accessCode, setAccessCode] = useState('');
  const [modelName, setModelName] = useState(prefill?.modelName ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isBambu = kind === 'FDM_BAMBU';

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await post('/api/printers', {
        name: name.trim(),
        kind,
        host: host.trim(),
        serial: serial.trim() || null,
        accessCode: accessCode.trim() || null,
        modelName: modelName.trim() || null,
        buildX: prefill?.buildX ?? null,
        buildY: prefill?.buildY ?? null,
        buildZ: prefill?.buildZ ?? null,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
      <div className="card w-full max-w-lg p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Add printer</h2>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={saving}>
            <X size={16} />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="label" htmlFor="p-kind">Type</label>
            <select
              id="p-kind"
              className="w-full"
              value={kind}
              onChange={(e) => setKind(e.target.value as PrinterKind)}
            >
              <option value="FDM_BAMBU">Bambu Lab — filament, LAN mode</option>
              <option value="RESIN_SDCP">Resin — Elegoo / Anycubic (SDCP)</option>
            </select>
          </div>

          <div>
            <label className="label" htmlFor="p-name">Name</label>
            <input
              id="p-name"
              className="w-full"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={isBambu ? 'X1 Carbon' : 'Saturn 4 Ultra'}
            />
          </div>

          <div>
            <label className="label" htmlFor="p-host">IP address or hostname</label>
            <input
              id="p-host"
              className="w-full font-mono"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="192.168.1.50"
            />
          </div>

          <div>
            <label className="label" htmlFor="p-serial">
              {isBambu ? 'Serial number' : 'Mainboard ID'}
            </label>
            <input
              id="p-serial"
              className="w-full font-mono"
              value={serial}
              onChange={(e) => setSerial(e.target.value)}
              placeholder={isBambu ? '01P00A123456789' : 'discovered automatically'}
            />
            <p className="mt-1 text-xs text-muted">
              {isBambu
                ? 'On the printer: Settings → Device. Required — it addresses the MQTT topics.'
                : 'Found by network scan. Required to send commands.'}
            </p>
          </div>

          {isBambu && (
            <div>
              <label className="label" htmlFor="p-code">LAN access code</label>
              <input
                id="p-code"
                className="w-full font-mono"
                type="password"
                value={accessCode}
                onChange={(e) => setAccessCode(e.target.value)}
                placeholder="8 characters"
                autoComplete="off"
              />
              <p className="mt-1 text-xs text-muted">
                On the printer: Settings → Network → LAN Only Mode. Stored encrypted and
                never sent back to the browser.
              </p>
            </div>
          )}

          <div>
            <label className="label" htmlFor="p-model">Model (optional)</label>
            <input
              id="p-model"
              className="w-full"
              value={modelName}
              onChange={(e) => setModelName(e.target.value)}
              placeholder={isBambu ? 'X1C' : 'Saturn 4 Ultra'}
            />
          </div>
        </div>

        {error && <p className="mt-3 rounded bg-bad/10 px-3 py-2 text-sm text-bad">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={submit}
            disabled={saving || !name.trim() || !host.trim()}
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            Save printer
          </button>
        </div>
      </div>
    </div>
  );
}

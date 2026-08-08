'use client';

import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { Plus, Loader2, Trash2, X, Save, Info } from 'lucide-react';
import { api, post, patch, del } from '@/lib/api-client';
import type { SlicerProfile, Technology, PrinterKind } from '@/lib/types';

export function ProfilesPanel() {
  const [profiles, setProfiles] = useState<SlicerProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<SlicerProfile | 'new' | null>(null);

  const load = useCallback(async () => {
    try {
      setProfiles(await api<SlicerProfile[]>('/api/profiles'));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load profiles');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Slicer profiles</h1>
        <button type="button" className="btn-primary" onClick={() => setEditing('new')}>
          <Plus size={15} />
          New profile
        </button>
      </div>

      <div className="card flex items-start gap-2 p-4 text-sm text-muted">
        <Info size={16} className="mt-0.5 shrink-0" />
        <div className="space-y-1">
          <p>
            <strong className="text-ink">Filament (FDM)</strong> profiles are OrcaSlicer JSON.
            The most reliable way to make one is to configure the print in OrcaSlicer, then
            export the machine, process and filament presets and paste them here.
          </p>
          <p>
            <strong className="text-ink">Resin (SLA)</strong> profiles are PrusaSlicer INI in
            SLA mode. Display resolution, panel size and exposure all live in the machine
            config — get those wrong and prints fail in obvious ways. Output is converted to
            your printer&apos;s format by UVtools.
          </p>
        </div>
      </div>

      {error && <p className="rounded bg-bad/10 px-3 py-2 text-sm text-bad">{error}</p>}

      {loading && (
        <div className="grid place-items-center py-16 text-muted">
          <Loader2 size={22} className="animate-spin" />
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        {profiles.map((profile) => (
          <div key={profile.id} className="card p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="flex items-center gap-2 truncate font-medium">
                  {profile.name}
                  {profile.isDefault && (
                    <span className="chip border-accent/40 text-accent">default</span>
                  )}
                </p>
                <p className="mt-0.5 text-xs text-muted">
                  {profile.technology} → .{profile.outputFormat}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <button type="button" className="btn-ghost" onClick={() => setEditing(profile)}>
                  Edit
                </button>
                <button
                  type="button"
                  className="btn-ghost text-bad"
                  onClick={async () => {
                    if (!confirm(`Delete profile "${profile.name}"?`)) return;
                    try {
                      await del(`/api/profiles/${profile.id}`);
                      void load();
                    } catch (err) {
                      setError(err instanceof Error ? err.message : 'Could not delete');
                    }
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>

            {profile.description && (
              <p className="mt-2 text-sm text-muted">{profile.description}</p>
            )}
          </div>
        ))}
      </div>

      {editing && (
        <ProfileForm
          profile={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function ProfileForm({
  profile,
  onClose,
  onSaved,
}: {
  profile: SlicerProfile | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(profile?.name ?? '');
  const [technology, setTechnology] = useState<Technology>(profile?.technology ?? 'FDM');
  const [printerKind, setPrinterKind] = useState<PrinterKind | ''>(profile?.printerKind ?? '');
  const [description, setDescription] = useState(profile?.description ?? '');
  const [outputFormat, setOutputFormat] = useState(profile?.outputFormat ?? 'gcode.3mf');
  const [machineConfig, setMachineConfig] = useState(profile?.machineConfig ?? '');
  const [processConfig, setProcessConfig] = useState(profile?.processConfig ?? '');
  const [materialConfig, setMaterialConfig] = useState(profile?.materialConfig ?? '');
  const [extraArgs, setExtraArgs] = useState(profile?.extraArgs ?? '');
  const [isDefault, setIsDefault] = useState(profile?.isDefault ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isSla = technology === 'SLA';

  const submit = async () => {
    setSaving(true);
    setError(null);
    const body = {
      name: name.trim(),
      technology,
      printerKind: printerKind || null,
      description: description.trim() || null,
      outputFormat: outputFormat.trim(),
      machineConfig: machineConfig || null,
      processConfig: processConfig || null,
      materialConfig: materialConfig || null,
      extraArgs: extraArgs.trim() || null,
      isDefault,
    };
    try {
      if (profile) await patch(`/api/profiles/${profile.id}`, body);
      else await post('/api/profiles', body);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
      <div className="card max-h-[92vh] w-full max-w-3xl overflow-y-auto p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            {profile ? `Edit ${profile.name}` : 'New slicer profile'}
          </h2>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={saving}>
            <X size={16} />
          </button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="label" htmlFor="pf-name">Name</label>
            <input id="pf-name" className="w-full" value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div>
            <label className="label" htmlFor="pf-tech">Technology</label>
            <select
              id="pf-tech"
              className="w-full"
              value={technology}
              disabled={Boolean(profile)}
              onChange={(e) => {
                const next = e.target.value as Technology;
                setTechnology(next);
                setOutputFormat(next === 'SLA' ? 'ctb' : 'gcode.3mf');
              }}
            >
              <option value="FDM">FDM — filament (OrcaSlicer)</option>
              <option value="SLA">SLA — resin (PrusaSlicer + UVtools)</option>
            </select>
            {profile && (
              <p className="mt-1 text-xs text-muted">
                Technology can&apos;t change after creation — make a new profile instead.
              </p>
            )}
          </div>

          <div>
            <label className="label" htmlFor="pf-out">Output format</label>
            <input
              id="pf-out"
              className="w-full font-mono"
              value={outputFormat}
              onChange={(e) => setOutputFormat(e.target.value)}
              placeholder={isSla ? 'ctb' : 'gcode.3mf'}
            />
            <p className="mt-1 text-xs text-muted">
              {isSla ? 'ctb, goo, cbddlp or sl1' : 'gcode.3mf for Bambu'}
            </p>
          </div>

          <div className="sm:col-span-2">
            <label className="label" htmlFor="pf-desc">Description</label>
            <input
              id="pf-desc"
              className="w-full"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="0.2mm layers, 15% infill, no supports"
            />
          </div>

          <div className="sm:col-span-2">
            <label className="label" htmlFor="pf-machine">
              {isSla ? 'Machine config (PrusaSlicer INI, SLA mode)' : 'Machine preset (Orca JSON)'}
            </label>
            <textarea
              id="pf-machine"
              className="h-40 w-full resize-y font-mono text-xs"
              value={machineConfig}
              onChange={(e) => setMachineConfig(e.target.value)}
              spellCheck={false}
            />
          </div>

          <div className="sm:col-span-2">
            <label className="label" htmlFor="pf-process">
              {isSla ? 'Print config (optional, appended to the INI)' : 'Process preset (Orca JSON)'}
            </label>
            <textarea
              id="pf-process"
              className="h-32 w-full resize-y font-mono text-xs"
              value={processConfig}
              onChange={(e) => setProcessConfig(e.target.value)}
              spellCheck={false}
            />
          </div>

          <div className="sm:col-span-2">
            <label className="label" htmlFor="pf-material">
              {isSla ? 'Resin config (optional)' : 'Filament preset (Orca JSON)'}
            </label>
            <textarea
              id="pf-material"
              className="h-32 w-full resize-y font-mono text-xs"
              value={materialConfig}
              onChange={(e) => setMaterialConfig(e.target.value)}
              spellCheck={false}
            />
          </div>

          <div>
            <label className="label" htmlFor="pf-args">Extra CLI arguments</label>
            <input
              id="pf-args"
              className="w-full font-mono"
              value={extraArgs}
              onChange={(e) => setExtraArgs(e.target.value)}
              placeholder="--scale 1.02"
            />
          </div>

          <div className="flex items-end">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={isDefault}
                onChange={(e) => setIsDefault(e.target.checked)}
              />
              Default for {technology}
            </label>
          </div>
        </div>

        {error && <p className="mt-3 rounded bg-bad/10 px-3 py-2 text-sm text-bad">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            className={clsx('btn-primary')}
            onClick={submit}
            disabled={saving || !name.trim() || !outputFormat.trim()}
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Save profile
          </button>
        </div>
      </div>
    </div>
  );
}

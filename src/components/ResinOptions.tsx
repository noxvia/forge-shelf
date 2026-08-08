'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react';
import clsx from 'clsx';

export interface ResinOptionsValue {
  rotateX?: number;
  rotateY?: number;
  hollow?: boolean;
  hollowThicknessMm?: number;
  supports?: boolean;
  supportTreeType?: 'default' | 'branching';
  supportElevationMm?: number;
  supportHeadDiameterMm?: number;
  supportsBuildplateOnly?: boolean;
  pad?: boolean;
  padAroundObject?: boolean;
  layerHeightMm?: number;
  exposureSeconds?: number;
}

/**
 * Per-model resin settings, layered over the profile.
 *
 * Everything here is left undefined until touched, so an untouched control
 * means "whatever the profile says" rather than silently forcing a default.
 */
export function ResinOptions({
  value,
  onChange,
}: {
  value: ResinOptionsValue;
  onChange: (v: ResinOptionsValue) => void;
}) {
  const [open, setOpen] = useState(false);
  const set = <K extends keyof ResinOptionsValue>(k: K, v: ResinOptionsValue[K]) =>
    onChange({ ...value, [k]: v });

  const touched = Object.values(value).filter((v) => v !== undefined).length;

  return (
    <div className="rounded border border-edge">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-panel2"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        Resin options
        <span className="ml-auto text-xs text-muted">
          {touched > 0 ? `${touched} overridden` : 'using profile'}
        </span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-edge p-3">
          {/* --- orientation ------------------------------------------------ */}
          <div className="grid grid-cols-2 gap-2">
            <NumField
              label="Tilt X°"
              hint="Angle off the plate. 20–30° is typical."
              value={value.rotateX}
              onChange={(v) => set('rotateX', v)}
              step={5}
            />
            <NumField
              label="Tilt Y°"
              value={value.rotateY}
              onChange={(v) => set('rotateY', v)}
              step={5}
            />
          </div>

          {/* --- supports --------------------------------------------------- */}
          <Toggle
            label="Supports"
            value={value.supports}
            onChange={(v) => set('supports', v)}
          />
          {value.supports !== false && (
            <div className="grid grid-cols-2 gap-2 pl-1">
              <div>
                <label className="label">Style</label>
                <select
                  className="w-full text-sm"
                  value={value.supportTreeType ?? ''}
                  onChange={(e) =>
                    set(
                      'supportTreeType',
                      e.target.value ? (e.target.value as 'default' | 'branching') : undefined,
                    )
                  }
                >
                  <option value="">Profile default</option>
                  <option value="default">Pillars</option>
                  <option value="branching">Branching (tree)</option>
                </select>
              </div>
              <NumField
                label="Tip Ø mm"
                hint="Smaller marks less but grips less."
                value={value.supportHeadDiameterMm}
                onChange={(v) => set('supportHeadDiameterMm', v)}
                step={0.1}
              />
              <NumField
                label="Lift mm"
                hint="Height above the pad."
                value={value.supportElevationMm}
                onChange={(v) => set('supportElevationMm', v)}
                step={1}
              />
              <div className="flex items-end">
                <Toggle
                  label="Plate only"
                  value={value.supportsBuildplateOnly}
                  onChange={(v) => set('supportsBuildplateOnly', v)}
                  compact
                />
              </div>
            </div>
          )}

          {/* --- pad -------------------------------------------------------- */}
          <Toggle label="Pad / raft" value={value.pad} onChange={(v) => set('pad', v)} />
          {value.pad !== false && (
            <div className="pl-1">
              <Toggle
                label="Pad hugs object"
                value={value.padAroundObject}
                onChange={(v) => set('padAroundObject', v)}
                compact
              />
            </div>
          )}

          {/* --- hollowing -------------------------------------------------- */}
          <Toggle label="Hollow" value={value.hollow} onChange={(v) => set('hollow', v)} />
          {value.hollow && (
            <>
              <div className="pl-1">
                <NumField
                  label="Wall mm"
                  hint="2mm is a safe floor for most resins."
                  value={value.hollowThicknessMm}
                  onChange={(v) => set('hollowThicknessMm', v)}
                  step={0.5}
                />
              </div>
              <p className="flex items-start gap-2 rounded bg-bad/10 px-2 py-1.5 text-xs text-bad">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>
                  No drain holes. PrusaSlicer can only place those in its GUI, so this will be
                  a sealed shell full of uncured resin — it can suction to the FEP and burst.
                  Add drain holes in a mesh editor first, or print solid.
                </span>
              </p>
            </>
          )}

          {/* --- exposure --------------------------------------------------- */}
          <div className="grid grid-cols-2 gap-2">
            <NumField
              label="Layer mm"
              value={value.layerHeightMm}
              onChange={(v) => set('layerHeightMm', v)}
              step={0.01}
            />
            <NumField
              label="Exposure s"
              value={value.exposureSeconds}
              onChange={(v) => set('exposureSeconds', v)}
              step={0.1}
            />
          </div>

          {touched > 0 && (
            <button
              type="button"
              className="btn-ghost w-full justify-center text-xs"
              onClick={() => onChange({})}
            >
              Reset to profile
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function NumField({
  label,
  hint,
  value,
  onChange,
  step = 1,
}: {
  label: string;
  hint?: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  step?: number;
}) {
  return (
    <div>
      <label className="label" title={hint}>
        {label}
      </label>
      <input
        type="number"
        step={step}
        className={clsx('w-full text-sm', value === undefined && 'text-muted')}
        placeholder="profile"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      />
    </div>
  );
}

/** Tri-state: undefined (inherit), true, false. */
function Toggle({
  label,
  value,
  onChange,
  compact,
}: {
  label: string;
  value: boolean | undefined;
  onChange: (v: boolean | undefined) => void;
  compact?: boolean;
}) {
  const next = () => onChange(value === undefined ? true : value ? false : undefined);
  return (
    <button
      type="button"
      onClick={next}
      className={clsx(
        'flex w-full items-center justify-between rounded px-2 py-1.5 text-sm hover:bg-panel2',
        compact && 'text-xs',
      )}
    >
      <span>{label}</span>
      <span
        className={clsx(
          'rounded px-1.5 py-0.5 text-xs',
          value === undefined && 'text-muted',
          value === true && 'bg-good/15 text-good',
          value === false && 'bg-bad/15 text-bad',
        )}
      >
        {value === undefined ? 'profile' : value ? 'on' : 'off'}
      </span>
    </button>
  );
}

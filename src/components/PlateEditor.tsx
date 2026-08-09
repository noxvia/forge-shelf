'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { Move3d, RotateCw, Scaling, Loader2, Trash2, Layers } from 'lucide-react';
import clsx from 'clsx';

export interface PlateItem {
  id: string;
  posX: number;
  posY: number;
  posZ: number;
  rotX: number;
  rotY: number;
  rotZ: number;
  scale: number;
  file: { id: string; filename: string; bboxX: number | null };
}

export interface BuildVolume {
  x: number;
  y: number;
  z: number;
}

type Mode = 'translate' | 'rotate' | 'scale';

/**
 * Interactive build plate.
 *
 * The transform convention here must match src/tools/bake_plate.py exactly:
 * scale, then rotate X→Y→Z, then normalise so the object's XY centre is at its
 * position and its lowest point rests on the plate. three.js Euler order 'XYZ'
 * composes as Rz·Ry·Rx, which is the same order the bake script applies. Get
 * this wrong and a plate looks correct on screen but slices somewhere else.
 */
export function PlateEditor({
  items,
  volume,
  selectedId,
  onSelect,
  onTransform,
  onCommit,
  onRemove,
}: {
  items: PlateItem[];
  volume: BuildVolume;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Live during a drag — cheap, local only. */
  onTransform: (id: string, t: Partial<PlateItem>) => void;
  /** Drag finished; safe to persist. */
  onCommit: () => void;
  onRemove: (id: string) => void;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const orbitRef = useRef<OrbitControls | null>(null);
  const gizmoRef = useRef<TransformControls | null>(null);
  /** plateItem.id -> the Object3D carrying it. */
  const objectsRef = useRef<Map<string, THREE.Object3D>>(new Map());
  const rootRef = useRef<THREE.Group | null>(null);

  const [mode, setMode] = useState<Mode>('translate');
  const [loading, setLoading] = useState(true);
  const [outOfBounds, setOutOfBounds] = useState<Set<string>>(new Set());

  // Callbacks change every render; hold them in refs so the scene effect can
  // stay mounted for the component's lifetime.
  const cb = useRef({ onSelect, onTransform, onCommit });
  cb.current = { onSelect, onTransform, onCommit };

  // --- scene, once ---------------------------------------------------------
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f141c);

    const camera = new THREE.PerspectiveCamera(
      45,
      mount.clientWidth / Math.max(1, mount.clientHeight),
      0.5,
      5000,
    );

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    mount.appendChild(renderer.domElement);

    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.enableDamping = true;
    orbit.dampingFactor = 0.08;

    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(1, 1.5, 1);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.45);
    fill.position.set(-1, 0.5, -1);
    scene.add(fill);

    // Printer space is Z-up; three.js is Y-up. Rotating one root group keeps
    // every transform in the app in printer coordinates.
    const root = new THREE.Group();
    root.rotation.x = -Math.PI / 2;
    scene.add(root);
    rootRef.current = root;

    const gizmo = new TransformControls(camera, renderer.domElement);
    gizmo.setSpace('local');
    // In three r169 TransformControls is a Controls, not an Object3D — the
    // visual part has to be fetched and added separately.
    scene.add(gizmo.getHelper());
    gizmo.addEventListener('dragging-changed', (e) => {
      orbit.enabled = !e.value;
      if (!e.value) cb.current.onCommit();
    });
    gizmoRef.current = gizmo;

    sceneRef.current = scene;
    cameraRef.current = camera;
    rendererRef.current = renderer;
    orbitRef.current = orbit;

    let frame = 0;
    const animate = () => {
      frame = requestAnimationFrame(animate);
      orbit.update();
      renderer.render(scene, camera);
    };
    animate();

    const resize = new ResizeObserver(() => {
      if (!mount.clientWidth || !mount.clientHeight) return;
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    });
    resize.observe(mount);

    // Click to select; a click that was really a drag must not change selection.
    let downAt = { x: 0, y: 0 };
    const onDown = (e: PointerEvent) => (downAt = { x: e.clientX, y: e.clientY });
    const onUp = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) return;
      const rect = renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, camera);
      const hits = ray.intersectObjects([...objectsRef.current.values()], true);
      if (hits.length === 0) {
        cb.current.onSelect(null);
        return;
      }
      // Walk up to the object that carries the plate item id.
      let o: THREE.Object3D | null = hits[0].object;
      while (o && !o.userData.plateItemId) o = o.parent;
      cb.current.onSelect((o?.userData.plateItemId as string) ?? null);
    };
    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('pointerup', onUp);

    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointerup', onUp);
      gizmo.detach();
      gizmo.dispose();
      orbit.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      mount.removeChild(renderer.domElement);
    };
  }, []);

  // --- build volume --------------------------------------------------------
  useEffect(() => {
    const root = rootRef.current;
    const camera = cameraRef.current;
    const orbit = orbitRef.current;
    if (!root || !camera || !orbit) return;

    const previous = root.getObjectByName('build-volume');
    if (previous) {
      root.remove(previous);
      previous.traverse((c) => {
        if (c instanceof THREE.LineSegments) {
          c.geometry.dispose();
          (c.material as THREE.Material).dispose();
        }
      });
    }

    const group = new THREE.Group();
    group.name = 'build-volume';

    // Box drawn from the plate origin, so printer coordinates read directly.
    const box = new THREE.BoxGeometry(volume.x, volume.y, volume.z);
    box.translate(volume.x / 2, volume.y / 2, volume.z / 2);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(box),
      new THREE.LineBasicMaterial({ color: 0x2a3140 }),
    );
    group.add(edges);

    const plate = new THREE.GridHelper(Math.max(volume.x, volume.y), 20, 0x3a4354, 0x232a36);
    plate.rotation.x = Math.PI / 2;
    plate.position.set(volume.x / 2, volume.y / 2, 0);
    group.add(plate);

    root.add(group);

    const span = Math.max(volume.x, volume.y, volume.z);
    camera.position.set(volume.x / 2 + span * 0.8, -span * 0.9, span * 0.8);
    camera.near = span / 500;
    camera.far = span * 20;
    camera.updateProjectionMatrix();
    orbit.target.set(volume.x / 2, volume.y / 2, volume.z * 0.2);
    orbit.update();
  }, [volume.x, volume.y, volume.z]);

  /** Applies a plate item's transform using the same order as the bake script. */
  const applyTransform = useCallback((obj: THREE.Object3D, item: PlateItem) => {
    obj.scale.setScalar(item.scale);
    obj.rotation.set(
      THREE.MathUtils.degToRad(item.rotX),
      THREE.MathUtils.degToRad(item.rotY),
      THREE.MathUtils.degToRad(item.rotZ),
      'XYZ',
    );
    obj.position.set(0, 0, 0);
    obj.updateMatrixWorld(true);

    // Normalise: XY centre to the item's position, lowest point on the plate.
    const box = new THREE.Box3().setFromObject(obj);
    obj.position.set(
      item.posX - (box.min.x + box.max.x) / 2,
      item.posY - (box.min.y + box.max.y) / 2,
      item.posZ - box.min.z,
    );
    obj.updateMatrixWorld(true);
  }, []);

  /** Recomputes which objects poke outside the build volume. */
  const checkBounds = useCallback(() => {
    const bad = new Set<string>();
    for (const [id, obj] of objectsRef.current) {
      const b = new THREE.Box3().setFromObject(obj);
      if (
        b.min.x < -0.01 || b.min.y < -0.01 || b.min.z < -0.01 ||
        b.max.x > volume.x + 0.01 || b.max.y > volume.y + 0.01 || b.max.z > volume.z + 0.01
      ) {
        bad.add(id);
      }
      obj.traverse((c) => {
        if (c instanceof THREE.Mesh) {
          const m = c.material as THREE.MeshStandardMaterial;
          m.color.set(bad.has(id) ? 0xf85149 : 0xc9d4e3);
        }
      });
    }
    setOutOfBounds(bad);
  }, [volume]);

  // --- load / sync objects -------------------------------------------------
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let cancelled = false;

    const wanted = new Set(items.map((i) => i.id));

    // Drop anything no longer on the plate.
    for (const [id, obj] of objectsRef.current) {
      if (!wanted.has(id)) {
        root.remove(obj);
        obj.traverse((c) => {
          if (c instanceof THREE.Mesh) {
            c.geometry.dispose();
            (c.material as THREE.Material).dispose();
          }
        });
        objectsRef.current.delete(id);
      }
    }

    const load = async () => {
      for (const item of items) {
        const existing = objectsRef.current.get(item.id);
        if (existing) {
          applyTransform(existing, item);
          continue;
        }

        const geometry = await loadGeometry(item.file.id, item.file.filename).catch(() => null);
        if (cancelled || !geometry) continue;

        const mesh = new THREE.Mesh(
          geometry,
          new THREE.MeshStandardMaterial({ color: 0xc9d4e3, roughness: 0.55, metalness: 0.08 }),
        );
        mesh.userData.plateItemId = item.id;
        objectsRef.current.set(item.id, mesh);
        root.add(mesh);
        applyTransform(mesh, item);
      }
      if (!cancelled) {
        checkBounds();
        setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [items, applyTransform, checkBounds]);

  // --- gizmo attach + live feedback ---------------------------------------
  useEffect(() => {
    const gizmo = gizmoRef.current;
    if (!gizmo) return;

    const obj = selectedId ? objectsRef.current.get(selectedId) : null;
    if (obj) gizmo.attach(obj);
    else gizmo.detach();
    gizmo.setMode(mode);

    if (!obj || !selectedId) return;

    const onChange = () => {
      const box = new THREE.Box3().setFromObject(obj);
      cb.current.onTransform(selectedId, {
        posX: round((box.min.x + box.max.x) / 2),
        posY: round((box.min.y + box.max.y) / 2),
        posZ: round(box.min.z),
        rotX: round(THREE.MathUtils.radToDeg(obj.rotation.x)),
        rotY: round(THREE.MathUtils.radToDeg(obj.rotation.y)),
        rotZ: round(THREE.MathUtils.radToDeg(obj.rotation.z)),
        scale: round(obj.scale.x),
      });
      checkBounds();
    };

    gizmo.addEventListener('objectChange', onChange);
    return () => gizmo.removeEventListener('objectChange', onChange);
  }, [selectedId, mode, checkBounds]);

  return (
    <div className="relative overflow-hidden rounded-lg border border-edge">
      <div ref={mountRef} className="h-[560px] w-full" />

      {loading && (
        <div className="absolute inset-0 grid place-items-center bg-bg/60">
          <Loader2 size={22} className="animate-spin text-muted" />
        </div>
      )}

      <div className="absolute left-3 top-3 flex gap-1 rounded bg-bg/80 p-1">
        {(
          [
            ['translate', Move3d, 'Move'],
            ['rotate', RotateCw, 'Rotate'],
            ['scale', Scaling, 'Scale'],
          ] as const
        ).map(([m, Icon, label]) => (
          <button
            key={m}
            type="button"
            title={label}
            className={clsx(
              'rounded px-2 py-1.5 text-xs',
              mode === m ? 'bg-accent text-bg' : 'text-muted hover:text-ink',
            )}
            onClick={() => setMode(m)}
          >
            <Icon size={14} />
          </button>
        ))}
      </div>

      <div className="pointer-events-none absolute right-3 top-3 rounded bg-bg/80 px-2 py-1 text-right font-mono text-xs text-muted">
        <div>{volume.x} × {volume.y} × {volume.z} mm</div>
        <div>
          {items.length} object{items.length === 1 ? '' : 's'}
        </div>
      </div>

      {outOfBounds.size > 0 && (
        <div className="absolute inset-x-3 bottom-3 rounded bg-bad/15 px-3 py-2 text-xs text-bad">
          {outOfBounds.size} object{outOfBounds.size === 1 ? '' : 's'} outside the build volume —
          slicing will be refused until they fit.
        </div>
      )}

      {selectedId && (
        <button
          type="button"
          className="btn-danger absolute bottom-3 left-3"
          onClick={() => onRemove(selectedId)}
        >
          <Trash2 size={13} />
          Remove
        </button>
      )}

      {items.length === 0 && !loading && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-center text-muted">
          <div>
            <Layers size={28} className="mx-auto mb-2" />
            <p className="text-sm">Add a model to start arranging</p>
          </div>
        </div>
      )}
    </div>
  );
}

const round = (n: number) => Math.round(n * 100) / 100;

async function loadGeometry(fileId: string, filename: string): Promise<THREE.BufferGeometry> {
  const url = `/api/files/${fileId}`;
  const ext = filename.toLowerCase().split('.').pop() ?? '';

  if (ext === 'stl') {
    return new STLLoader().loadAsync(url);
  }

  const group =
    ext === '3mf' ? await new ThreeMFLoader().loadAsync(url) : await new OBJLoader().loadAsync(url);

  // Flatten whatever the loader produced into one geometry so a plate item is
  // always a single mesh with one transform.
  const geometries: THREE.BufferGeometry[] = [];
  group.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      const g = child.geometry.clone();
      child.updateMatrixWorld(true);
      g.applyMatrix4(child.matrixWorld);
      geometries.push(g.index ? g.toNonIndexed() : g);
    }
  });
  if (geometries.length === 0) throw new Error(`No geometry in ${filename}`);
  if (geometries.length === 1) return geometries[0];

  const merged = new THREE.BufferGeometry();
  const positions = geometries.flatMap((g) => Array.from(g.attributes.position.array));
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  merged.computeVertexNormals();
  return merged;
}

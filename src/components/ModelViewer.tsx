'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { Camera, Loader2, Grid3x3, Box } from 'lucide-react';

interface Props {
  fileId: string;
  filename: string;
  /** When set, a "capture thumbnail" button appears and posts to this model. */
  modelId?: string;
  className?: string;
  onThumbnail?: () => void;
}

/**
 * Interactive mesh preview.
 *
 * Also the app's thumbnail generator: rendering already happens here with a
 * working WebGL context, so a capture is a canvas readback rather than a
 * headless GL stack in the container.
 */
export function ModelViewer({ fileId, filename, modelId, className, onThumbnail }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const meshRef = useRef<THREE.Object3D | null>(null);
  const gridRef = useRef<THREE.GridHelper | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dims, setDims] = useState<{ x: number; y: number; z: number } | null>(null);
  const [wireframe, setWireframe] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [capturing, setCapturing] = useState(false);

  // --- scene setup (once) --------------------------------------------------
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x11161f);

    const camera = new THREE.PerspectiveCamera(
      45,
      mount.clientWidth / Math.max(1, mount.clientHeight),
      0.1,
      10_000,
    );
    camera.position.set(120, 90, 120);

    // preserveDrawingBuffer keeps the frame readable after render, which is what
    // makes toBlob() work for thumbnail capture.
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    scene.add(new THREE.AmbientLight(0xffffff, 0.55));

    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(1, 1.4, 1);
    scene.add(key);

    const fill = new THREE.DirectionalLight(0x88aaff, 0.5);
    fill.position.set(-1, 0.4, -1);
    scene.add(fill);

    const grid = new THREE.GridHelper(400, 40, 0x3a4354, 0x232a36);
    scene.add(grid);

    sceneRef.current = scene;
    cameraRef.current = camera;
    rendererRef.current = renderer;
    controlsRef.current = controls;
    gridRef.current = grid;

    let frame = 0;
    const animate = () => {
      frame = requestAnimationFrame(animate);
      controls.update();
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

    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      controls.dispose();
      renderer.dispose();
      // WebGL contexts are a finite resource; releasing explicitly stops the
      // browser dropping older canvases when several viewers have been opened.
      renderer.forceContextLoss();
      mount.removeChild(renderer.domElement);
      disposeTree(scene);
    };
  }, []);

  // --- load the mesh -------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    const scene = sceneRef.current;
    if (!scene) return;

    setLoading(true);
    setError(null);

    const url = `/api/files/${fileId}`;
    const ext = filename.toLowerCase().split('.').pop() ?? '';

    const place = (object: THREE.Object3D) => {
      if (cancelled) return;

      if (meshRef.current) {
        scene.remove(meshRef.current);
        disposeTree(meshRef.current);
      }

      const material = new THREE.MeshStandardMaterial({
        color: 0xc9d4e3,
        roughness: 0.55,
        metalness: 0.08,
        flatShading: false,
      });

      object.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.material = material;
          child.geometry.computeVertexNormals();
        }
      });

      // Centre on the origin and stand it on the grid.
      const box = new THREE.Box3().setFromObject(object);
      const size = box.getSize(new THREE.Vector3());
      const centre = box.getCenter(new THREE.Vector3());
      object.position.sub(centre);
      object.position.y += size.y / 2;

      scene.add(object);
      meshRef.current = object;
      setDims({
        x: round(size.x),
        y: round(size.z), // three.js Y is up; print beds call that depth
        z: round(size.y),
      });

      frameCamera(size);
      setLoading(false);
    };

    const onError = (err: unknown) => {
      if (cancelled) return;
      console.error('[viewer]', err);
      setError(
        `Could not render ${filename}. The file is stored safely — this viewer handles ` +
          `STL, 3MF and OBJ.`,
      );
      setLoading(false);
    };

    if (ext === 'stl') {
      new STLLoader().load(
        url,
        (geometry) => place(new THREE.Mesh(geometry)),
        undefined,
        onError,
      );
    } else if (ext === '3mf') {
      new ThreeMFLoader().load(url, (group) => place(group), undefined, onError);
    } else if (ext === 'obj') {
      new OBJLoader().load(url, (group) => place(group), undefined, onError);
    } else {
      setError(`No preview for .${ext} files — STL, 3MF and OBJ can be rendered.`);
      setLoading(false);
    }

    return () => {
      cancelled = true;
    };
  }, [fileId, filename]);

  const frameCamera = (size: THREE.Vector3) => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    const grid = gridRef.current;
    if (!camera || !controls) return;

    const maxDim = Math.max(size.x, size.y, size.z, 1);
    const distance = (maxDim / 2 / Math.tan((camera.fov * Math.PI) / 360)) * 2.1;

    camera.position.set(distance * 0.7, distance * 0.55 + size.y / 2, distance * 0.7);
    camera.near = maxDim / 500;
    camera.far = distance * 20;
    camera.updateProjectionMatrix();

    controls.target.set(0, size.y / 2, 0);
    controls.update();

    // Keep the grid proportionate to the model rather than a fixed 400mm.
    if (grid) {
      const span = Math.max(200, Math.ceil((maxDim * 2) / 50) * 50);
      grid.scale.setScalar(span / 400);
    }
  };

  useEffect(() => {
    meshRef.current?.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        (child.material as THREE.MeshStandardMaterial).wireframe = wireframe;
      }
    });
  }, [wireframe]);

  useEffect(() => {
    if (gridRef.current) gridRef.current.visible = showGrid;
  }, [showGrid]);

  const captureThumbnail = useCallback(async () => {
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    const grid = gridRef.current;
    if (!renderer || !scene || !camera || !modelId) return;

    setCapturing(true);
    try {
      // Render one clean frame without the grid.
      const gridWasVisible = grid?.visible ?? false;
      if (grid) grid.visible = false;
      renderer.render(scene, camera);

      const blob = await new Promise<Blob | null>((resolve) =>
        renderer.domElement.toBlob(resolve, 'image/png'),
      );

      if (grid) grid.visible = gridWasVisible;
      if (!blob) throw new Error('Could not read the canvas');

      const res = await fetch(`/api/models/${modelId}/thumbnail`, {
        method: 'PUT',
        headers: { 'content-type': 'image/png' },
        body: blob,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Upload failed');

      onThumbnail?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Thumbnail capture failed');
    } finally {
      setCapturing(false);
    }
  }, [modelId, onThumbnail]);

  return (
    <div className={className}>
      <div className="relative overflow-hidden rounded-lg border border-edge bg-[#11161f]">
        <div ref={mountRef} className="h-[420px] w-full" />

        {loading && (
          <div className="absolute inset-0 grid place-items-center bg-bg/60">
            <div className="flex items-center gap-2 text-sm text-muted">
              <Loader2 size={16} className="animate-spin" />
              Loading {filename}…
            </div>
          </div>
        )}

        {error && (
          <div className="absolute inset-x-0 bottom-0 bg-bad/15 px-3 py-2 text-xs text-bad">
            {error}
          </div>
        )}

        {dims && !loading && (
          <div className="pointer-events-none absolute left-3 top-3 rounded bg-bg/75 px-2 py-1 font-mono text-xs text-muted">
            {dims.x} × {dims.y} × {dims.z} mm
          </div>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-secondary"
          onClick={() => setWireframe((w) => !w)}
          aria-pressed={wireframe}
        >
          <Box size={14} />
          {wireframe ? 'Solid' : 'Wireframe'}
        </button>

        <button
          type="button"
          className="btn-secondary"
          onClick={() => setShowGrid((g) => !g)}
          aria-pressed={showGrid}
        >
          <Grid3x3 size={14} />
          Grid
        </button>

        {modelId && (
          <button
            type="button"
            className="btn-secondary"
            onClick={captureThumbnail}
            disabled={capturing || loading || Boolean(error)}
            title="Use the current view as this model's library thumbnail"
          >
            {capturing ? <Loader2 size={14} className="animate-spin" /> : <Camera size={14} />}
            Set thumbnail
          </button>
        )}
      </div>
    </div>
  );
}

const round = (n: number) => Math.round(n * 100) / 100;

/** three.js does not free GPU memory on remove(); walk the tree and dispose. */
function disposeTree(root: THREE.Object3D) {
  root.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry?.dispose();
      const material = child.material;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material?.dispose();
    }
  });
}

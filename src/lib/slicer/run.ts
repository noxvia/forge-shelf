import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  combined: string;
  timedOut: boolean;
}

/**
 * Runs a slicer with a hard timeout, capturing output line by line.
 *
 * Slicer AppImages still link GTK and will refuse to start without a display
 * even when told to work headlessly, so commands are wrapped in xvfb-run when
 * it's available. DISPLAY is left unset otherwise.
 */
export async function run(
  bin: string,
  args: string[],
  opts: {
    cwd?: string;
    timeoutMs: number;
    env?: Record<string, string>;
    onLog?: (line: string) => void;
    useXvfb?: boolean;
  },
): Promise<RunResult> {
  const useXvfb = opts.useXvfb && (await hasXvfb());
  const cmd = useXvfb ? 'xvfb-run' : bin;
  const cmdArgs = useXvfb ? ['-a', '--server-args=-screen 0 1280x1024x24', bin, ...args] : args;

  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, {
      cwd: opts.cwd,
      env: {
        ...process.env,
        // AppImages want a writable home for their config.
        HOME: opts.cwd ?? process.env.HOME ?? '/tmp',
        ...opts.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let combined = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);

    const attach = (
      stream: NodeJS.ReadableStream,
      sink: (chunk: string) => void,
    ) => {
      let carry = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        sink(chunk);
        combined += chunk;
        carry += chunk;
        const lines = carry.split('\n');
        carry = lines.pop() ?? '';
        for (const line of lines) if (line.trim()) opts.onLog?.(line.trimEnd());
      });
      stream.on('end', () => {
        if (carry.trim()) opts.onLog?.(carry.trimEnd());
      });
    };

    attach(child.stdout, (c) => (stdout += c));
    attach(child.stderr, (c) => (stderr += c));

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, combined, timedOut });
    });
  });
}

let xvfbCache: boolean | null = null;

async function hasXvfb(): Promise<boolean> {
  if (xvfbCache !== null) return xvfbCache;
  xvfbCache = await exists('/usr/bin/xvfb-run');
  return xvfbCache;
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Recursively lists files in a directory, returning absolute paths. */
export async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string) {
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = `${d}/${e.name}`;
      if (e.isDirectory()) await walk(full);
      else out.push(full);
    }
  }
  await walk(dir);
  return out;
}

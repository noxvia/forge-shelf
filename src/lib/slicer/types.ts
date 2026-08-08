import type { SlicerProfile } from '@prisma/client';

export interface SliceRequest {
  /** Absolute path to the input mesh. */
  inputPath: string;
  /** Absolute path to an empty working directory the adapter owns. */
  workDir: string;
  profile: SlicerProfile;
  /** Called with each line of slicer output so progress can be streamed. */
  onLog?: (line: string) => void;
  timeoutMs: number;
}

export interface SliceResult {
  /** Absolute path to the machine-ready file. */
  outputPath: string;
  outputName: string;
  log: string;
  /** Anything the adapter could scrape out of the output. */
  meta: Record<string, unknown>;
}

export interface SlicerAdapter {
  readonly id: string;
  /** Absolute path of the binary this adapter drives. */
  binPath(): string;
  /** Resolves false when the binary isn't installed in this image. */
  available(): Promise<boolean>;
  slice(req: SliceRequest): Promise<SliceResult>;
}

export class SlicerUnavailableError extends Error {
  constructor(name: string, binPath: string) {
    super(
      `${name} is not installed at ${binPath}. Rebuild the image with ` +
        `--build-arg INSTALL_SLICERS=true, or point the matching *_BIN env var at a binary.`,
    );
  }
}

export class SliceFailedError extends Error {
  constructor(
    message: string,
    readonly log: string,
  ) {
    super(message);
  }
}

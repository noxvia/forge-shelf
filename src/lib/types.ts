/**
 * Shapes the API actually returns. Prisma's generated types describe the
 * database; these describe the wire, where BigInt has become a string and
 * relations are only partially included.
 */

export type FileKind = 'MESH' | 'SLICED' | 'IMAGE' | 'DOC' | 'ARCHIVE';
export type Technology = 'FDM' | 'SLA';
export type PrinterKind = 'FDM_BAMBU' | 'RESIN_SDCP';
export type TaskStatus = 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELLED';
export type JobStatus =
  | 'QUEUED'
  | 'UPLOADING'
  | 'STARTING'
  | 'PRINTING'
  | 'PAUSED'
  | 'DONE'
  | 'FAILED'
  | 'CANCELLED';

export interface Tag {
  id: string;
  name: string;
  slug: string;
  color: string | null;
  count?: number;
}

export interface ModelFile {
  id: string;
  modelId: string;
  kind: FileKind;
  filename: string;
  sizeBytes: string;
  mime: string | null;
  sha256: string | null;
  triangles: number | null;
  bboxX: number | null;
  bboxY: number | null;
  bboxZ: number | null;
  volumeMm3: number | null;
  technology: Technology | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

export interface ModelSummary {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  designer: string | null;
  favorite: boolean;
  printCount: number;
  thumbnailPath: string | null;
  createdAt: string;
  updatedAt: string;
  tags: Tag[];
  files: Pick<ModelFile, 'id' | 'kind' | 'filename' | 'sizeBytes' | 'technology'>[];
}

export interface SliceTask {
  id: string;
  status: TaskStatus;
  error: string | null;
  log: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  profile: { id: string; name: string; technology: Technology; outputFormat: string };
  inputFile: { id: string; filename: string; modelId?: string };
  outputFile: { id: string; filename: string; sizeBytes: string; meta?: unknown } | null;
}

export interface PrintJob {
  id: string;
  status: JobStatus;
  progress: number;
  layerCurrent: number | null;
  layerTotal: number | null;
  etaSeconds: number | null;
  remoteFilename: string | null;
  error: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  printer: { id: string; name: string; kind: PrinterKind; status?: string };
  file: { id: string; filename: string; sizeBytes: string; meta?: unknown };
  model: { id: string; name: string; slug?: string } | null;
}

export interface PrinterStatusPayload {
  state: 'idle' | 'printing' | 'paused' | 'finished' | 'error' | 'offline';
  progress: number | null;
  layerCurrent: number | null;
  layerTotal: number | null;
  etaSeconds: number | null;
  jobName: string | null;
  nozzleTemp?: number | null;
  bedTemp?: number | null;
  chamberTemp?: number | null;
  uvLedTemp?: number | null;
  message?: string | null;
}

export interface Printer {
  id: string;
  name: string;
  kind: PrinterKind;
  host: string;
  port: number | null;
  serial: string | null;
  modelName: string | null;
  buildX: number | null;
  buildY: number | null;
  buildZ: number | null;
  status: string;
  statusJson: PrinterStatusPayload | null;
  lastSeenAt: string | null;
  lastError: string | null;
  enabled: boolean;
  hasSecret: boolean;
  _count?: { jobs: number };
}

export interface SlicerProfile {
  id: string;
  name: string;
  technology: Technology;
  printerKind: PrinterKind | null;
  description: string | null;
  machineConfig: string | null;
  processConfig: string | null;
  materialConfig: string | null;
  outputFormat: string;
  extraArgs: string | null;
  isDefault: boolean;
}

export interface ModelDetail extends ModelSummary {
  sourceUrl: string | null;
  license: string | null;
  notes: string | null;
  files: ModelFile[];
  jobs: PrintJob[];
  sliceTasks: SliceTask[];
}

export interface Discovered {
  kind: PrinterKind;
  host: string;
  name: string;
  serial: string | null;
  modelName: string | null;
  firmware: string | null;
  buildX: number | null;
  buildY: number | null;
  buildZ: number | null;
  needsSecret: boolean;
  alreadyAdded: boolean;
  existingId: string | null;
}

export const PRINTER_KIND_LABEL: Record<PrinterKind, string> = {
  FDM_BAMBU: 'Bambu Lab (LAN)',
  RESIN_SDCP: 'Resin (SDCP)',
};

export const FILE_KIND_LABEL: Record<FileKind, string> = {
  MESH: 'Model',
  SLICED: 'Print-ready',
  IMAGE: 'Image',
  DOC: 'Document',
  ARCHIVE: 'Archive',
};

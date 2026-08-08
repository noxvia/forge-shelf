import { JobStatus } from '@prisma/client';

/** Statuses that mean the printer is committed to this job. */
export const ACTIVE_JOB_STATUSES: JobStatus[] = [
  JobStatus.QUEUED,
  JobStatus.UPLOADING,
  JobStatus.STARTING,
  JobStatus.PRINTING,
  JobStatus.PAUSED,
];

export function isActive(status: JobStatus): boolean {
  return ACTIVE_JOB_STATUSES.includes(status);
}

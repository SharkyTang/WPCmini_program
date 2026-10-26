import type { PermanentDeleteResult } from "../types";

const STORAGE_PREFIX = "wine-admin-pending-purge-cleanup-v1";
const MAX_JOBS_PER_ADMIN = 20;

export interface PendingPurgeCleanupJob {
  cleanupJobId: string;
  pendingFileCount: number;
  deletedFileCount: number;
  retainedReferencedCount: number;
  updatedAt: string;
}

function storageKey(uid: string): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(uid)}`;
}

function normalizeCount(value: unknown): number {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0;
}

function normalizeJob(value: unknown): PendingPurgeCleanupJob | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const cleanupJobId = String(raw.cleanupJobId || "").trim();
  if (!cleanupJobId) return null;
  return {
    cleanupJobId,
    pendingFileCount: normalizeCount(raw.pendingFileCount),
    deletedFileCount: normalizeCount(raw.deletedFileCount),
    retainedReferencedCount: normalizeCount(raw.retainedReferencedCount),
    updatedAt: String(raw.updatedAt || new Date(0).toISOString()),
  };
}

export function toPendingPurgeCleanupJob(
  result: PermanentDeleteResult & { updatedAt?: string },
): PendingPurgeCleanupJob {
  return {
    cleanupJobId: result.cleanupJobId,
    pendingFileCount: normalizeCount(result.pendingFileCount),
    deletedFileCount: normalizeCount(result.deletedFileCount),
    retainedReferencedCount: normalizeCount(result.retainedReferencedCount),
    updatedAt: result.updatedAt || new Date().toISOString(),
  };
}

export function readPendingPurgeCleanupJobs(uid: string): PendingPurgeCleanupJob[] {
  if (!uid) return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey(uid)) || "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeJob)
      .filter((job): job is PendingPurgeCleanupJob => Boolean(job))
      .filter((job) => job.pendingFileCount > 0)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, MAX_JOBS_PER_ADMIN);
  } catch {
    return [];
  }
}

export function upsertPendingPurgeCleanupJob(
  uid: string,
  job: PendingPurgeCleanupJob,
): void {
  if (!uid || !job.cleanupJobId || job.pendingFileCount <= 0) return;
  const next = [
    job,
    ...readPendingPurgeCleanupJobs(uid).filter(
      (candidate) => candidate.cleanupJobId !== job.cleanupJobId,
    ),
  ].slice(0, MAX_JOBS_PER_ADMIN);
  try {
    localStorage.setItem(storageKey(uid), JSON.stringify(next));
  } catch {
    // Persistence is best-effort. Server-side purge jobs remain authoritative.
  }
}

export function removePendingPurgeCleanupJob(uid: string, cleanupJobId: string): void {
  if (!uid || !cleanupJobId) return;
  try {
    const next = readPendingPurgeCleanupJobs(uid).filter(
      (job) => job.cleanupJobId !== cleanupJobId,
    );
    if (next.length) {
      localStorage.setItem(storageKey(uid), JSON.stringify(next));
    } else {
      localStorage.removeItem(storageKey(uid));
    }
  } catch {
    // A storage failure must not block the recycle-bin workflow.
  }
}

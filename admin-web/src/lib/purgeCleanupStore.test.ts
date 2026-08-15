import { beforeEach, describe, expect, it } from "vitest";
import {
  readPendingPurgeCleanupJobs,
  removePendingPurgeCleanupJob,
  toPendingPurgeCleanupJob,
  upsertPendingPurgeCleanupJob,
} from "./purgeCleanupStore";

describe("pending purge cleanup storage", () => {
  beforeEach(() => localStorage.clear());

  it("isolates cleanup jobs by administrator UID", () => {
    const job = toPendingPurgeCleanupJob({
      deleted: 1,
      cleanupJobId: "purge-job-1",
      deletedFileCount: 3,
      retainedReferencedCount: 1,
      pendingFileCount: 2,
    });
    upsertPendingPurgeCleanupJob("uid-administrator", job);

    expect(readPendingPurgeCleanupJobs("uid-administrator")).toEqual([job]);
    expect(readPendingPurgeCleanupJobs("uid-sharky")).toEqual([]);
  });

  it("stores only cleanup metadata and removes completed jobs", () => {
    const job = toPendingPurgeCleanupJob({
      deleted: 2,
      cleanupJobId: "purge-job-2",
      deletedFileCount: 4,
      retainedReferencedCount: 0,
      pendingFileCount: 1,
    });
    upsertPendingPurgeCleanupJob("uid-administrator", job);
    const stored = JSON.parse(localStorage.getItem(localStorage.key(0) || "") || "[]");
    expect(stored[0]).toEqual(job);
    expect(Object.keys(stored[0])).toEqual([
      "cleanupJobId",
      "pendingFileCount",
      "deletedFileCount",
      "retainedReferencedCount",
      "updatedAt",
    ]);

    removePendingPurgeCleanupJob("uid-administrator", job.cleanupJobId);
    expect(readPendingPurgeCleanupJobs("uid-administrator")).toEqual([]);
  });

  it("does not persist jobs that already finished", () => {
    const job = toPendingPurgeCleanupJob({
      deleted: 1,
      cleanupJobId: "purge-job-finished",
      deletedFileCount: 5,
      retainedReferencedCount: 0,
      pendingFileCount: 0,
    });
    upsertPendingPurgeCleanupJob("uid-administrator", job);
    expect(readPendingPurgeCleanupJobs("uid-administrator")).toEqual([]);
  });
});

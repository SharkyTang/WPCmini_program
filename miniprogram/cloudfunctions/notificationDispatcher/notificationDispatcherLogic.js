const crypto = require("crypto");

const DELIVERY_ID_LENGTH = 32;

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function toTimestamp(value) {
  if (value instanceof Date) return value.getTime();
  if (value && typeof value.toDate === "function") {
    return value.toDate().getTime();
  }
  const timestamp = new Date(value || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function buildDeliveryId(announcementId, openid) {
  const identity = `${trimText(announcementId)}\n${trimText(openid)}`;
  return crypto.createHash("sha256").update(identity).digest("hex").slice(0, DELIVERY_ID_LENGTH);
}

function createLeaseOwner() {
  return crypto.randomBytes(12).toString("hex");
}

function isJobClaimable(job, now = Date.now()) {
  if (!job || !job._id) return false;
  if (job.status === "pending") return true;
  if (job.status !== "processing") return false;
  return toTimestamp(job.leaseUntil) <= Number(now);
}

function mergeJobCounts(job = {}, counts = {}) {
  return {
    successCount: Number(job.successCount || 0) + Number(counts.success || 0),
    failedCount: Number(job.failedCount || 0) + Number(counts.failed || 0),
    skippedCount: Number(job.skippedCount || 0) + Number(counts.skipped || 0),
  };
}

function getCompletedJobStatus(counts = {}) {
  return Number(counts.failedCount || 0) > 0 ? "partial_failed" : "completed";
}

module.exports = {
  DELIVERY_ID_LENGTH,
  buildDeliveryId,
  createLeaseOwner,
  getCompletedJobStatus,
  isJobClaimable,
  mergeJobCounts,
  toTimestamp,
};

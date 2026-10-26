const {
  compareJobs,
  getJobAction,
  normalizeInquiryEmailStatus,
  resolveInquiryEmailStatus,
} = require("./inquiryNotifierLogic");

const INQUIRY_COLLECTION = "inquiries";
const JOB_COLLECTION = "inquiry_alert_jobs";
const CANDIDATE_STATUSES = Object.freeze(["pending", "retry", "processing"]);

function isDocumentNotFound(error) {
  const code = error && (error.errCode || error.code);
  const message = error && (error.errMsg || error.message);
  return (
    code === -502005
    || code === "DATABASE_DOCUMENT_NOT_EXIST"
    || /document.*not found|does not exist/i.test(message || "")
  );
}

async function readDocument(document) {
  try {
    const response = await document.get();
    return response.data || null;
  } catch (error) {
    if (isDocumentNotFound(error)) return null;
    throw error;
  }
}

function createCloudbaseRepository(db) {
  const command = db.command;

  async function recordInquiryEmailStatus(transaction, inquiryId, nextValue) {
    const nextStatus = normalizeInquiryEmailStatus(nextValue);
    if (!inquiryId || !nextStatus) return false;
    const document = transaction.collection(INQUIRY_COLLECTION).doc(inquiryId);
    const inquiry = await readDocument(document);
    if (!inquiry) return false;
    const currentStatus = normalizeInquiryEmailStatus(
      inquiry.emailNotificationStatus
    );
    const resolvedStatus = resolveInquiryEmailStatus(currentStatus, nextStatus);
    if (!resolvedStatus || resolvedStatus === currentStatus) return false;
    await document.update({
      data: {
        emailNotificationStatus: resolvedStatus,
        emailNotificationUpdatedAt: db.serverDate(),
      },
    });
    return true;
  }

  async function getInquiry(inquiryId) {
    return readDocument(db.collection(INQUIRY_COLLECTION).doc(inquiryId));
  }

  async function listPendingInquiries(limit) {
    const response = await db
      .collection(INQUIRY_COLLECTION)
      .where({ alertTaskStatus: "pending" })
      .orderBy("createdAt", "asc")
      .limit(limit)
      .get();
    return response.data || [];
  }

  async function markInquiryAlertState(inquiryId, state = {}) {
    if (!inquiryId) return false;
    await db.collection(INQUIRY_COLLECTION).doc(inquiryId).update({
      data: {
        alertTaskStatus: state.status || "scheduled",
        alertTaskPlanVersion: state.planVersion || "",
        alertTaskStopReason: state.stopReason || "",
        alertTaskUpdatedAt: db.serverDate(),
      },
    });
    return true;
  }

  async function ensureJob(job) {
    return db.runTransaction(async (transaction) => {
      const document = transaction.collection(JOB_COLLECTION).doc(job._id);
      const existing = await readDocument(document);
      if (existing) return { created: false, job: existing };
      const record = {
        planVersion: job.planVersion,
        inquiryId: job.inquiryId,
        stageKey: job.stageKey,
        recipientRole: job.recipientRole,
        submittedAt: job.submittedAt,
        inquirySource: job.inquirySource,
        dueAt: job.dueAt,
        status: "pending",
        attempt: 0,
        nextAttemptAt: null,
        leaseOwner: "",
        leaseUntil: null,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate(),
      };
      await document.set({ data: record });
      return { created: true, job: { _id: job._id, ...record } };
    });
  }

  async function listActionableJobs(now, limit, scanLimit) {
    const dueAt = new Date(now);
    // Query each lifecycle independently. A large number of future 5/15-minute
    // jobs must never crowd an already-due immediate job out of the scan page.
    const definitions = [
      { status: "pending", field: "dueAt" },
      { status: "retry", field: "nextAttemptAt" },
      { status: "processing", field: "leaseUntil" },
    ];
    const responses = await Promise.all(definitions.map(({ status, field }) => (
      db.collection(JOB_COLLECTION)
        .where({ status, [field]: command.lte(dueAt) })
        .orderBy(field, "asc")
        .limit(scanLimit)
        .get()
    )));
    return responses.flatMap((response) => response.data || [])
      .filter((job) => Boolean(getJobAction(job, now)))
      .sort(compareJobs)
      .slice(0, limit);
  }

  async function claimJob(jobId, leaseOwner, now, leaseMs) {
    return db.runTransaction(async (transaction) => {
      const document = transaction.collection(JOB_COLLECTION).doc(jobId);
      const current = await readDocument(document);
      const action = getJobAction(current, now);
      if (!action) return { disposition: "busy", job: null };

      if (action === "recover_unknown") {
        await recordInquiryEmailStatus(
          transaction,
          current.inquiryId,
          "delivery_unknown"
        );
        await document.update({
          data: {
            status: "delivery_unknown",
            lastErrorCategory: "timeout",
            lastErrorCode: "LEASE_EXPIRED",
            leaseOwner: "",
            leaseUntil: null,
            finishedAt: new Date(now),
            updatedAt: db.serverDate(),
          },
        });
        return {
          disposition: "recovered_unknown",
          job: { ...current, status: "delivery_unknown" },
        };
      }

      const attempt = Number(current.attempt || 0) + 1;
      const leaseUntil = new Date(now + leaseMs);
      await document.update({
        data: {
          status: "processing",
          attempt,
          leaseOwner,
          leaseUntil,
          updatedAt: db.serverDate(),
        },
      });
      return {
        disposition: "claimed",
        job: {
          ...current,
          status: "processing",
          attempt,
          leaseOwner,
          leaseUntil,
        },
      };
    });
  }

  async function finishJob(jobId, leaseOwner, patch) {
    return db.runTransaction(async (transaction) => {
      const document = transaction.collection(JOB_COLLECTION).doc(jobId);
      const current = await readDocument(document);
      if (
        !current
        || current.status !== "processing"
        || current.leaseOwner !== leaseOwner
      ) {
        return false;
      }
      // Resolve and read the parent before issuing either transaction write;
      // this remains compatible with transaction engines that require all
      // reads to happen before writes.
      await recordInquiryEmailStatus(
        transaction,
        current.inquiryId,
        patch.status
      );
      await document.update({
        data: {
          ...patch,
          leaseOwner: "",
          leaseUntil: null,
          updatedAt: db.serverDate(),
        },
      });
      return true;
    });
  }

  return {
    ensureJob,
    finishJob,
    getInquiry,
    claimJob,
    listActionableJobs,
    listPendingInquiries,
    markInquiryAlertState,
  };
}

module.exports = {
  CANDIDATE_STATUSES,
  INQUIRY_COLLECTION,
  JOB_COLLECTION,
  createCloudbaseRepository,
  isDocumentNotFound,
};

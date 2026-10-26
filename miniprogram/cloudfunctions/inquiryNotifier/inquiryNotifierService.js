const {
  PLAN_VERSION,
  buildSafeMail,
  buildStageJobs,
  classifyDeliveryError,
  createLeaseOwner,
  getInquiryStopReason,
  getNotifierConfiguration,
  getRetryDelayMs,
  isValidInternalToken,
} = require("./inquiryNotifierLogic");

const JOB_LEASE_MS = 2 * 60 * 1000;
const INQUIRY_SCAN_LIMIT = 100;
const SEED_CONCURRENCY = 5;
const JOB_BATCH_SIZE = 5;
const JOB_PROCESS_CONCURRENCY = 5;
const JOB_CANDIDATE_SCAN_LIMIT = 100;

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function ok(data = {}) {
  return { ok: true, ...data };
}

function fail(code, message) {
  return { ok: false, code, message };
}

function normalizeInquiryId(value) {
  const id = trimText(value);
  if (!id || id.length > 128 || id.includes("/")) return "";
  return id;
}

function countStatuses(results) {
  return results.reduce((counts, item) => {
    const status = item.status || "unknown";
    counts[status] = Number(counts[status] || 0) + 1;
    return counts;
  }, {});
}

async function mapWithConcurrency(items, concurrency, worker) {
  const source = Array.isArray(items) ? items : [];
  const results = new Array(source.length);
  let nextIndex = 0;
  const workerCount = Math.min(
    source.length,
    Math.max(1, Math.floor(Number(concurrency) || 1))
  );
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < source.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(source[index], index);
    }
  }));
  return results;
}

function createInquiryNotifierService(options = {}) {
  const repository = options.repository;
  const mailer = options.mailer;
  const env = options.env || {};
  const now = typeof options.now === "function" ? options.now : Date.now;
  const leaseOwnerFactory = options.leaseOwnerFactory || createLeaseOwner;
  const leaseMs = Number(options.leaseMs || JOB_LEASE_MS);

  if (!repository) throw new Error("repository is required");

  function getRuntime() {
    const notifier = getNotifierConfiguration(env);
    if (!notifier.enabled) {
      return { ready: false, reason: "feature_disabled", notifier };
    }
    if (!notifier.ready) {
      return { ready: false, reason: notifier.reason, notifier };
    }
    const mailStatus = mailer && typeof mailer.getStatus === "function"
      ? mailer.getStatus()
      : { ready: false, reason: "smtp_not_configured" };
    if (!mailStatus.ready) {
      return {
        ready: false,
        reason: mailStatus.reason || "smtp_not_configured",
        notifier,
      };
    }
    return { ready: true, reason: "", notifier };
  }

  async function seedInquiry(inquiry) {
    const stopReason = getInquiryStopReason(inquiry);
    const inquiryId = normalizeInquiryId(inquiry && (inquiry._id || inquiry.id));
    if (stopReason) {
      if (inquiryId && typeof repository.markInquiryAlertState === "function") {
        await repository.markInquiryAlertState(inquiryId, {
          status: "stopped",
          planVersion: PLAN_VERSION,
          stopReason,
        });
      }
      return { created: 0, stopReason, jobs: [] };
    }
    const jobs = buildStageJobs(inquiry, now());
    let created = 0;
    for (const job of jobs) {
      const result = await repository.ensureJob(job);
      if (result && result.created) created += 1;
    }
    if (inquiryId && typeof repository.markInquiryAlertState === "function") {
      await repository.markInquiryAlertState(inquiryId, {
        status: "scheduled",
        planVersion: PLAN_VERSION,
        stopReason: "",
      });
    }
    return { created, stopReason: "", jobs };
  }

  async function finishClaimedJob(job, leaseOwner, patch) {
    const finished = await repository.finishJob(job._id, leaseOwner, patch);
    return finished;
  }

  async function finishTransientFailure(job, leaseOwner, code) {
    const retryDelay = getRetryDelayMs(job.attempt);
    if (retryDelay === null) {
      const finished = await finishClaimedJob(job, leaseOwner, {
        status: "failed",
        lastErrorCategory: "transient",
        lastErrorCode: code,
        finishedAt: new Date(now()),
      });
      return { status: finished ? "failed" : "lost_lease" };
    }
    const finished = await finishClaimedJob(job, leaseOwner, {
      status: "retry",
      lastErrorCategory: "transient",
      lastErrorCode: code,
      nextAttemptAt: new Date(now() + retryDelay),
    });
    return {
      status: finished ? "retry" : "lost_lease",
      retryDelayMs: retryDelay,
    };
  }

  async function processJob(jobId, runtime) {
    const leaseOwner = leaseOwnerFactory();
    const claimed = await repository.claimJob(jobId, leaseOwner, now(), leaseMs);
    if (!claimed || claimed.disposition === "busy") return { status: "busy" };
    if (claimed.disposition === "recovered_unknown") {
      return { status: "delivery_unknown" };
    }

    const job = claimed.job;
    let inquiry;
    try {
      inquiry = await repository.getInquiry(job.inquiryId);
    } catch (error) {
      return finishTransientFailure(job, leaseOwner, "DATASTORE_TEMPORARY");
    }

    const stopReason = getInquiryStopReason(inquiry);
    if (stopReason) {
      const finished = await finishClaimedJob(job, leaseOwner, {
        status: "cancelled",
        stopReason,
        finishedAt: new Date(now()),
      });
      return { status: finished ? "cancelled" : "lost_lease", stopReason };
    }

    const recipient = runtime.notifier.recipients[job.recipientRole];
    if (!recipient) {
      const finished = await finishClaimedJob(job, leaseOwner, {
        status: "permanent_failed",
        lastErrorCategory: "permanent",
        lastErrorCode: "INVALID_RECIPIENT",
        finishedAt: new Date(now()),
      });
      return { status: finished ? "permanent_failed" : "lost_lease" };
    }

    const message = buildSafeMail(job);
    let delivery;
    try {
      delivery = await mailer.send({
        recipient,
        ...message,
      });
      if (delivery && delivery.accepted === false) {
        const rejected = new Error("mail rejected");
        rejected.code = "INVALID_RECIPIENT";
        throw rejected;
      }
    } catch (error) {
      const classification = classifyDeliveryError(error);
      if (classification.category === "timeout") {
        // SMTP timeouts have an ambiguous outcome. Do not retry this stage: a
        // retry could duplicate a message that the provider already accepted.
        const finished = await finishClaimedJob(job, leaseOwner, {
          status: "delivery_unknown",
          lastErrorCategory: "timeout",
          lastErrorCode: classification.code,
          finishedAt: new Date(now()),
        });
        return { status: finished ? "delivery_unknown" : "lost_lease" };
      }
      if (classification.category === "permanent") {
        const finished = await finishClaimedJob(job, leaseOwner, {
          status: "permanent_failed",
          lastErrorCategory: "permanent",
          lastErrorCode: classification.code,
          finishedAt: new Date(now()),
        });
        return { status: finished ? "permanent_failed" : "lost_lease" };
      }
      return finishTransientFailure(job, leaseOwner, classification.code);
    }

    try {
      const finished = await finishClaimedJob(job, leaseOwner, {
        status: "sent",
        sentAt: new Date(now()),
        finishedAt: new Date(now()),
        lastErrorCategory: "",
        lastErrorCode: "",
      });
      // If the lease was lost after SMTP accepted the message, retrying would
      // be unsafe. The stored lease recovery path will settle it as unknown.
      return { status: finished ? "sent" : "delivery_unknown" };
    } catch (error) {
      // SMTP has already returned success. Leave the processing lease intact;
      // the timer will convert an expired lease to delivery_unknown without
      // invoking SMTP again.
      return { status: "delivery_unknown" };
    }
  }

  async function processDueJobs(runtime) {
    const candidates = await repository.listActionableJobs(
      now(),
      JOB_BATCH_SIZE,
      JOB_CANDIDATE_SCAN_LIMIT
    );
    const results = await mapWithConcurrency(
      candidates,
      JOB_PROCESS_CONCURRENCY,
      async (candidate) => {
        try {
          return await processJob(candidate._id, runtime);
        } catch (error) {
          return { status: "worker_error" };
        }
      }
    );
    return { processed: results.length, counts: countStatuses(results) };
  }

  async function kick(event, runtime) {
    const inquiryId = normalizeInquiryId(event.inquiryId || event.id);
    if (!inquiryId) return fail("INVALID_INQUIRY_ID", "缺少有效的需求 ID");
    const inquiry = await repository.getInquiry(inquiryId);
    if (!inquiry) return fail("INQUIRY_NOT_FOUND", "需求不存在");
    const seeded = await seedInquiry(inquiry);
    if (seeded.stopReason) {
      return ok({ status: "stopped", stopReason: seeded.stopReason, enqueued: 0 });
    }
    const immediateJobs = seeded.jobs.filter((job) => (
      trimText(job.stageKey).endsWith("_immediate")
    ));
    const deliveries = await mapWithConcurrency(
      immediateJobs,
      immediateJobs.length || 1,
      async (job) => {
        try {
          return await processJob(job._id, runtime);
        } catch (error) {
          // One recipient must never prevent the other recipient's independent
          // job from being attempted. The durable job remains recoverable.
          return { status: "worker_error" };
        }
      }
    );
    const counts = countStatuses(deliveries);
    const statuses = Object.keys(counts);
    const status = statuses.length === 0
      ? "idle"
      : statuses.length === 1
        ? statuses[0]
        : "partial";
    return ok({
      status,
      enqueued: seeded.created,
      processed: deliveries.filter((delivery) => delivery.status !== "busy").length,
      counts,
    });
  }

  async function scan(runtime) {
    // Every new inquiry owns a durable pending marker. The query is
    // oldest-first; after a batch is scheduled its marker leaves the queue,
    // so record 101 is handled on the next tick instead of starving forever.
    const inquiries = typeof repository.listPendingInquiries === "function"
      ? await repository.listPendingInquiries(INQUIRY_SCAN_LIMIT)
      : [];
    let enqueued = 0;
    let stopped = 0;
    let seedFailed = 0;
    const seedResults = await mapWithConcurrency(
      inquiries,
      SEED_CONCURRENCY,
      async (inquiry) => {
        try {
          return await seedInquiry(inquiry);
        } catch (error) {
          // Keep its durable marker pending, but do not let one bad record
          // block the rest of this compensation batch.
          return null;
        }
      }
    );
    seedResults.forEach((result) => {
      if (!result) {
        seedFailed += 1;
        return;
      }
      enqueued += result.created;
      if (result.stopReason) stopped += 1;
    });
    const dispatched = await processDueJobs(runtime);
    return ok({
      status: dispatched.processed ? "processed" : "idle",
      scanned: inquiries.length,
      stopped,
      seedFailed,
      enqueued,
      processed: dispatched.processed,
      counts: dispatched.counts,
    });
  }

  async function handle(event = {}) {
    const action = trimText(event.action);
    const isTimer = Boolean(event && event.Type === "Timer");
    if (isTimer || action === "health" || action === "kick") {
      const providedToken = isTimer ? event.Message : event.internalToken;
      if (!isValidInternalToken(
        env.INQUIRY_NOTIFIER_INTERNAL_TOKEN,
        providedToken
      )) {
        return fail("UNAUTHORIZED", "内部调用校验失败");
      }
    }
    const runtime = getRuntime();
    if (action === "health") {
      return ok({
        status: runtime.ready ? "ready" : "disabled",
        reason: runtime.reason,
      });
    }
    if (!runtime.ready) {
      return ok({ status: "disabled", reason: runtime.reason });
    }
    if (isTimer) return scan(runtime);
    if (action === "kick") return kick(event, runtime);
    return fail("UNKNOWN_ACTION", "未知通知操作");
  }

  return {
    handle,
    processJob,
    seedInquiry,
  };
}

module.exports = {
  INQUIRY_SCAN_LIMIT,
  JOB_BATCH_SIZE,
  JOB_CANDIDATE_SCAN_LIMIT,
  JOB_LEASE_MS,
  JOB_PROCESS_CONCURRENCY,
  SEED_CONCURRENCY,
  createInquiryNotifierService,
  mapWithConcurrency,
  normalizeInquiryId,
};

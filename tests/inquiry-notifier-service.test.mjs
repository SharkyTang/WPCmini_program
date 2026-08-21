import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const notifierPath = resolve(
  __dirname,
  "../miniprogram/cloudfunctions/inquiryNotifier"
);
const logic = require(resolve(notifierPath, "inquiryNotifierLogic.js"));
const {
  createInquiryNotifierService,
  JOB_LEASE_MS,
} = require(resolve(notifierPath, "inquiryNotifierService.js"));

const INTERNAL_TOKEN = "test-inquiry-notifier-internal-token-20260821";
const ENABLED_ENV = Object.freeze({
  INQUIRY_EMAIL_ALERTS_ENABLED: "true",
  INQUIRY_NOTIFIER_INTERNAL_TOKEN: INTERNAL_TOKEN,
  INQUIRY_NOTIFY_PRIMARY_EMAIL: "primary@example.com",
  INQUIRY_NOTIFY_PRIMARY_EMAIL_2: "primary-2@example.com",
  INQUIRY_NOTIFY_BACKUP_EMAIL: "backup@example.com",
});

function authenticatedEvent(event = {}) {
  return event && event.Type === "Timer"
    ? { ...event, Message: INTERNAL_TOKEN }
    : { ...event, internalToken: INTERNAL_TOKEN };
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function createMemoryRepository(initial = {}) {
  const inquiries = new Map(
    (initial.inquiries || []).map((item) => [item._id, clone(item)])
  );
  const jobs = new Map(
    (initial.jobs || []).map((item) => [item._id, clone(item)])
  );
  const calls = {
    getInquiry: 0,
    ensureJob: 0,
    listPendingInquiries: 0,
    markInquiryAlertState: 0,
    listActionableJobs: 0,
    claimJob: 0,
    finishJob: 0,
  };

  return {
    calls,
    inquiries,
    jobs,
    async getInquiry(id) {
      calls.getInquiry += 1;
      return clone(inquiries.get(id) || null);
    },
    async ensureJob(job) {
      calls.ensureJob += 1;
      if (jobs.has(job._id)) {
        return { created: false, job: clone(jobs.get(job._id)) };
      }
      const stored = {
        ...clone(job),
        nextAttemptAt: null,
        leaseOwner: "",
        leaseUntil: null,
      };
      jobs.set(job._id, stored);
      return { created: true, job: clone(stored) };
    },
    async listPendingInquiries(limit) {
      calls.listPendingInquiries += 1;
      return Array.from(inquiries.values())
        .filter((item) => item.alertTaskStatus === "pending")
        .sort((a, b) => logic.toTimestamp(a.createdAt) - logic.toTimestamp(b.createdAt))
        .slice(0, limit)
        .map(clone);
    },
    async markInquiryAlertState(id, state) {
      calls.markInquiryAlertState += 1;
      const current = inquiries.get(id);
      if (!current) return false;
      Object.assign(current, {
        alertTaskStatus: state.status,
        alertTaskPlanVersion: state.planVersion,
        alertTaskStopReason: state.stopReason || "",
      });
      return true;
    },
    async listActionableJobs(now, limit, scanLimit) {
      calls.listActionableJobs += 1;
      return Array.from(jobs.values())
        .slice(0, scanLimit)
        .filter((job) => Boolean(logic.getJobAction(job, now)))
        .sort(logic.compareJobs)
        .slice(0, limit)
        .map(clone);
    },
    async claimJob(id, leaseOwner, now, leaseMs) {
      calls.claimJob += 1;
      const current = jobs.get(id);
      const action = logic.getJobAction(current, now);
      if (!action) return { disposition: "busy", job: null };
      if (action === "recover_unknown") {
        Object.assign(current, {
          status: "delivery_unknown",
          lastErrorCategory: "timeout",
          lastErrorCode: "LEASE_EXPIRED",
          leaseOwner: "",
          leaseUntil: null,
        });
        const inquiry = inquiries.get(current.inquiryId);
        if (inquiry) {
          inquiry.emailNotificationStatus = logic.resolveInquiryEmailStatus(
            inquiry.emailNotificationStatus,
            "delivery_unknown"
          );
        }
        return { disposition: "recovered_unknown", job: clone(current) };
      }
      Object.assign(current, {
        status: "processing",
        attempt: Number(current.attempt || 0) + 1,
        leaseOwner,
        leaseUntil: new Date(now + leaseMs),
      });
      return { disposition: "claimed", job: clone(current) };
    },
    async finishJob(id, leaseOwner, patch) {
      calls.finishJob += 1;
      const current = jobs.get(id);
      if (
        !current
        || current.status !== "processing"
        || current.leaseOwner !== leaseOwner
      ) {
        return false;
      }
      Object.assign(current, clone(patch), {
        leaseOwner: "",
        leaseUntil: null,
      });
      const inquiry = inquiries.get(current.inquiryId);
      const nextEmailStatus = logic.normalizeInquiryEmailStatus(patch.status);
      if (inquiry && nextEmailStatus) {
        inquiry.emailNotificationStatus = logic.resolveInquiryEmailStatus(
          inquiry.emailNotificationStatus,
          nextEmailStatus
        );
      }
      return true;
    },
  };
}

function createMailer(sendImpl = async () => ({ accepted: true })) {
  const sends = [];
  return {
    sends,
    getStatus() {
      return { ready: true, reason: "" };
    },
    async send(message) {
      sends.push(clone(message));
      return sendImpl(message);
    },
  };
}

function buildHarness(options = {}) {
  let clock = options.clock === undefined
    ? Date.parse("2026-08-21T00:00:00.000Z")
    : options.clock;
  const inquiry = options.inquiry || {
    _id: "inquiry_1",
    status: "new",
    alertTaskStatus: "pending",
    createdAt: new Date(clock),
    contact: "customer-secret-wechat",
    content: "customer-secret-requirement",
    openid: "customer-secret-openid",
  };
  const repository = options.repository || createMemoryRepository({
    inquiries: [inquiry],
    jobs: options.jobs || [],
  });
  const mailer = options.mailer || createMailer(options.sendImpl);
  const rawService = createInquiryNotifierService({
    repository,
    mailer,
    env: options.env || ENABLED_ENV,
    now: () => clock,
    leaseOwnerFactory: (() => {
      let sequence = 0;
      return () => `lease_${++sequence}`;
    })(),
  });
  const service = {
    ...rawService,
    handle(event) {
      return rawService.handle(authenticatedEvent(event));
    },
  };
  return {
    inquiry,
    mailer,
    repository,
    rawService,
    service,
    get clock() {
      return clock;
    },
    set clock(value) {
      clock = value;
    },
  };
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

await test("feature flag off performs no reads, writes, or sends", async () => {
  const repository = new Proxy({}, {
    get() {
      return async () => {
        throw new Error("repository must not be called");
      };
    },
  });
  const mailer = createMailer();
  const service = createInquiryNotifierService({
    repository,
    mailer,
    env: { INQUIRY_NOTIFIER_INTERNAL_TOKEN: INTERNAL_TOKEN },
  });
  const result = await service.handle(authenticatedEvent({
    action: "kick",
    inquiryId: "inquiry_1",
  }));
  assert.deepEqual(result, {
    ok: true,
    status: "disabled",
    reason: "feature_disabled",
  });
  assert.equal(mailer.sends.length, 0);
});

await test("health, kick, and timer fail closed before side effects without the internal token", async () => {
  const repository = new Proxy({}, {
    get() {
      return async () => {
        throw new Error("repository must not be called");
      };
    },
  });
  const mailer = createMailer();
  const service = createInquiryNotifierService({
    repository,
    mailer,
    env: ENABLED_ENV,
  });
  for (const event of [
    { action: "health" },
    { action: "kick", inquiryId: "inquiry_1", internalToken: "wrong" },
    { Type: "Timer", internalToken: INTERNAL_TOKEN },
  ]) {
    assert.deepEqual(await service.handle(event), {
      ok: false,
      code: "UNAUTHORIZED",
      message: "内部调用校验失败",
    });
  }
  const missingEnvironmentToken = createInquiryNotifierService({
    repository,
    mailer,
    env: { ...ENABLED_ENV, INQUIRY_NOTIFIER_INTERNAL_TOKEN: "" },
  });
  assert.equal((await missingEnvironmentToken.handle(authenticatedEvent({
    action: "health",
  }))).code, "UNAUTHORIZED");
  assert.equal(mailer.sends.length, 0);
});

await test("health reports safe configuration status without database access", async () => {
  const repository = new Proxy({}, {
    get() {
      return async () => {
        throw new Error("repository must not be called");
      };
    },
  });
  const disabledService = createInquiryNotifierService({
    repository,
    mailer: createMailer(),
    env: { INQUIRY_NOTIFIER_INTERNAL_TOKEN: INTERNAL_TOKEN },
  });
  assert.deepEqual(await disabledService.handle(authenticatedEvent({ action: "health" })), {
    ok: true,
    status: "disabled",
    reason: "feature_disabled",
  });

  const readyService = createInquiryNotifierService({
    repository,
    mailer: createMailer(),
    env: ENABLED_ENV,
  });
  assert.deepEqual(await readyService.handle(authenticatedEvent({ action: "health" })), {
    ok: true,
    status: "ready",
    reason: "",
  });

  const missingSecondPrimaryService = createInquiryNotifierService({
    repository,
    mailer: createMailer(),
    env: {
      ...ENABLED_ENV,
      INQUIRY_NOTIFY_PRIMARY_EMAIL_2: "",
    },
  });
  assert.deepEqual(
    await missingSecondPrimaryService.handle(authenticatedEvent({ action: "health" })),
    {
      ok: true,
      status: "disabled",
      reason: "recipient_not_configured",
    }
  );
});

await test("missing SMTP readiness disables safely before database access", async () => {
  const repository = new Proxy({}, {
    get() {
      return async () => {
        throw new Error("repository must not be called");
      };
    },
  });
  const service = createInquiryNotifierService({
    repository,
    mailer: {
      getStatus() {
        return { ready: false, reason: "smtp_not_configured" };
      },
    },
    env: ENABLED_ENV,
  });
  const result = await service.handle(authenticatedEvent({ Type: "Timer" }));
  assert.equal(result.ok, true);
  assert.equal(result.status, "disabled");
  assert.equal(result.reason, "smtp_not_configured");
});

await test("kick creates six jobs and independently notifies both primaries", async () => {
  const harness = buildHarness();
  const result = await harness.service.handle({
    action: "kick",
    inquiryId: harness.inquiry._id,
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "sent");
  assert.equal(result.enqueued, 6);
  assert.equal(result.processed, 2);
  assert.equal(result.counts.sent, 2);
  assert.equal(harness.repository.jobs.size, 6);
  assert.equal(harness.mailer.sends.length, 2);
  assert.equal(
    harness.repository.inquiries.get("inquiry_1").emailNotificationStatus,
    "sent"
  );
  assert.deepEqual(
    harness.mailer.sends.map((message) => message.recipient).sort(),
    ["primary-2@example.com", "primary@example.com"]
  );
});

await test("timer scan discovers an inquiry and sends both immediate stages", async () => {
  const harness = buildHarness();
  const result = await harness.service.handle({ Type: "Timer" });
  assert.equal(result.ok, true);
  assert.equal(result.scanned, 1);
  assert.equal(result.enqueued, 6);
  assert.equal(result.counts.sent, 2);
  assert.equal(harness.mailer.sends.length, 2);
  assert.equal(
    harness.repository.inquiries.get("inquiry_1").alertTaskStatus,
    "scheduled"
  );
});

await test("pending queue drains records beyond one hundred without permanent starvation", async () => {
  const clock = Date.parse("2026-08-21T00:10:00.000Z");
  const inquiries = Array.from({ length: 201 }, (_, index) => ({
    _id: `burst_${String(index).padStart(3, "0")}`,
    status: "new",
    alertTaskStatus: "pending",
    createdAt: new Date(clock - 201_000 + index * 1000),
  }));
  const repository = createMemoryRepository({ inquiries });
  const harness = buildHarness({ clock, repository });
  const first = await harness.service.handle({ Type: "Timer" });
  assert.equal(first.scanned, 100);
  assert.equal(
    Array.from(repository.inquiries.values())
      .filter((item) => item.alertTaskStatus === "pending").length,
    101
  );
  await harness.service.handle({ Type: "Timer" });
  assert.equal(
    Array.from(repository.inquiries.values())
      .filter((item) => item.alertTaskStatus === "pending").length,
    1
  );
  await harness.service.handle({ Type: "Timer" });
  assert.equal(
    Array.from(repository.inquiries.values())
      .filter((item) => item.alertTaskStatus === "pending").length,
    0
  );
});

await test("repeated and concurrent kicks cannot resend either immediate stage", async () => {
  let release;
  const blocked = new Promise((resolvePromise) => {
    release = resolvePromise;
  });
  const harness = buildHarness({
    sendImpl: () => blocked,
  });
  const first = harness.service.handle({ action: "kick", inquiryId: "inquiry_1" });
  while (harness.mailer.sends.length < 2) {
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }
  const concurrent = await harness.service.handle({
    action: "kick",
    inquiryId: "inquiry_1",
  });
  assert.equal(concurrent.status, "busy");
  assert.equal(concurrent.counts.busy, 2);
  assert.equal(harness.mailer.sends.length, 2);
  release({ accepted: true });
  await first;
  const repeated = await harness.service.handle({
    action: "kick",
    inquiryId: "inquiry_1",
  });
  assert.equal(repeated.status, "busy");
  assert.equal(repeated.counts.busy, 2);
  assert.equal(harness.mailer.sends.length, 2);
});

await test("one immediate recipient failure does not change the other job state", async () => {
  const transient = new Error("temporary connection failure");
  transient.code = "ECONNRESET";
  const harness = buildHarness({
    sendImpl: async (message) => {
      if (message.recipient === "primary@example.com") throw transient;
      return { accepted: true };
    },
  });
  const result = await harness.service.handle({
    action: "kick",
    inquiryId: "inquiry_1",
  });
  const primaryJob = harness.repository.jobs.get(
    logic.buildJobId("inquiry_1", "primary_immediate")
  );
  const primary2Job = harness.repository.jobs.get(
    logic.buildJobId("inquiry_1", "primary_2_immediate")
  );
  assert.equal(result.status, "partial");
  assert.equal(result.counts.retry, 1);
  assert.equal(result.counts.sent, 1);
  assert.equal(primaryJob.status, "retry");
  assert.equal(primary2Job.status, "sent");
});

await test("backup recipient is not sent until the five-minute stage", async () => {
  const harness = buildHarness();
  await harness.service.handle({ action: "kick", inquiryId: "inquiry_1" });
  assert.equal(
    harness.mailer.sends.some((message) => message.recipient === "backup@example.com"),
    false
  );
  harness.clock += 5 * 60 * 1000;
  const result = await harness.service.handle({ Type: "Timer" });
  assert.equal(result.counts.sent, 1);
  assert.equal(harness.mailer.sends.length, 3);
  assert.equal(harness.mailer.sends[2].recipient, "backup@example.com");
});

await test("claim before the five-minute stage cancels later delivery", async () => {
  const harness = buildHarness();
  await harness.service.handle({ action: "kick", inquiryId: "inquiry_1" });
  harness.clock += 5 * 60 * 1000;
  harness.repository.inquiries.get("inquiry_1").claimedAt = new Date(harness.clock);
  harness.repository.inquiries.get("inquiry_1").claimedBy = "admin_openid";
  const result = await harness.service.handle({ Type: "Timer" });
  const backupJobId = logic.buildJobId("inquiry_1", "backup_5m");
  assert.equal(result.counts.cancelled, 1);
  assert.equal(harness.repository.jobs.get(backupJobId).status, "cancelled");
  assert.equal(harness.repository.jobs.get(backupJobId).stopReason, "claimed");
  assert.equal(harness.mailer.sends.length, 2);
  assert.equal(
    harness.repository.inquiries.get("inquiry_1").emailNotificationStatus,
    "sent"
  );
});

await test("a cancelled first stage is reflected on the inquiry", async () => {
  const clock = Date.parse("2026-08-21T00:10:00.000Z");
  const inquiry = {
    _id: "inquiry_1",
    status: "new",
    claimedByOpenid: "admin_openid",
    createdAt: new Date(clock - 10 * 60 * 1000),
  };
  const [job] = logic.buildStageJobs(inquiry, clock);
  const harness = buildHarness({ clock, inquiry, jobs: [job] });
  const result = await harness.service.handle({ Type: "Timer" });
  assert.equal(result.counts.cancelled, 1);
  assert.equal(
    harness.repository.inquiries.get("inquiry_1").emailNotificationStatus,
    "cancelled"
  );
  assert.equal(harness.mailer.sends.length, 0);
});

await test("transient SMTP errors retry after 30s, 2m, and 5m then stop", async () => {
  const error = new Error("temporary connection failure");
  error.code = "ECONNRESET";
  const harness = buildHarness({
    sendImpl: async () => {
      throw error;
    },
  });
  const runtime = { notifier: logic.getNotifierConfiguration(ENABLED_ENV) };
  const jobId = logic.buildJobId("inquiry_1", "primary_immediate");

  const first = await harness.service.handle({ action: "kick", inquiryId: "inquiry_1" });
  assert.equal(first.status, "retry");
  assert.equal(harness.repository.jobs.get(jobId).nextAttemptAt.getTime(), harness.clock + 30_000);

  harness.clock += 30_000;
  const second = await harness.service.processJob(jobId, runtime);
  assert.equal(second.retryDelayMs, 120_000);
  assert.equal(harness.repository.jobs.get(jobId).nextAttemptAt.getTime(), harness.clock + 120_000);

  harness.clock += 120_000;
  const third = await harness.service.processJob(jobId, runtime);
  assert.equal(third.retryDelayMs, 300_000);
  assert.equal(harness.repository.jobs.get(jobId).nextAttemptAt.getTime(), harness.clock + 300_000);

  harness.clock += 300_000;
  const fourth = await harness.service.processJob(jobId, runtime);
  assert.equal(fourth.status, "failed");
  assert.equal(harness.repository.jobs.get(jobId).attempt, 4);
  assert.equal(harness.mailer.sends.length, 5);
  assert.equal(
    harness.repository.inquiries.get("inquiry_1").emailNotificationStatus,
    "failed"
  );
});

await test("permanent SMTP errors do not retry", async () => {
  const error = new Error("authentication rejected");
  error.code = "EAUTH";
  const harness = buildHarness({
    sendImpl: async () => {
      throw error;
    },
  });
  const result = await harness.service.handle({ action: "kick", inquiryId: "inquiry_1" });
  const jobId = logic.buildJobId("inquiry_1", "primary_immediate");
  assert.equal(result.status, "permanent_failed");
  assert.equal(harness.repository.jobs.get(jobId).status, "permanent_failed");
  assert.equal(harness.repository.jobs.get(jobId).lastErrorCode, "EAUTH");
  assert.equal(harness.repository.jobs.get(jobId).nextAttemptAt, null);
  assert.equal(harness.mailer.sends.length, 2);
  assert.equal(
    harness.repository.inquiries.get("inquiry_1").emailNotificationStatus,
    "permanent_failed"
  );
});

await test("SMTP timeout is delivery-unknown and is never retried", async () => {
  const error = new Error("socket timed out");
  error.code = "ETIMEDOUT";
  const harness = buildHarness({
    sendImpl: async () => {
      throw error;
    },
  });
  const result = await harness.service.handle({ action: "kick", inquiryId: "inquiry_1" });
  const jobId = logic.buildJobId("inquiry_1", "primary_immediate");
  assert.equal(result.status, "delivery_unknown");
  assert.equal(harness.repository.jobs.get(jobId).status, "delivery_unknown");
  const runtime = { notifier: logic.getNotifierConfiguration(ENABLED_ENV) };
  assert.equal((await harness.service.processJob(jobId, runtime)).status, "busy");
  assert.equal(harness.mailer.sends.length, 2);
  assert.equal(
    harness.repository.inquiries.get("inquiry_1").emailNotificationStatus,
    "delivery_unknown"
  );
});

await test("SMTP success followed by status persistence failure is never resent", async () => {
  const repository = createMemoryRepository({
    inquiries: [{
      _id: "inquiry_1",
      status: "new",
      alertTaskStatus: "pending",
      createdAt: new Date("2026-08-21T00:00:00.000Z"),
    }],
  });
  const originalFinishJob = repository.finishJob;
  let failSentPersistence = true;
  repository.finishJob = async (id, leaseOwner, patch) => {
    if (failSentPersistence && patch.status === "sent") {
      failSentPersistence = false;
      throw new Error("database temporarily unavailable");
    }
    return originalFinishJob(id, leaseOwner, patch);
  };
  const harness = buildHarness({ repository });
  const first = await harness.service.handle({
    action: "kick",
    inquiryId: "inquiry_1",
  });
  assert.equal(first.status, "partial");
  assert.equal(first.counts.delivery_unknown, 1);
  assert.equal(first.counts.sent, 1);
  assert.equal(harness.mailer.sends.length, 2);
  harness.clock += JOB_LEASE_MS + 1;
  const recovered = await harness.service.handle({ Type: "Timer" });
  assert.equal(recovered.counts.delivery_unknown, 1);
  assert.equal(harness.mailer.sends.length, 2);
});

await test("an expired processing lease becomes unknown without a duplicate send", async () => {
  const clock = Date.parse("2026-08-21T00:00:00.000Z");
  const inquiry = {
    _id: "inquiry_1",
    status: "new",
    createdAt: new Date(clock),
  };
  const [job] = logic.buildStageJobs(inquiry, clock);
  Object.assign(job, {
    status: "processing",
    attempt: 1,
    leaseOwner: "dead_worker",
    leaseUntil: new Date(clock - 1),
  });
  const harness = buildHarness({ clock, inquiry, jobs: [job] });
  const result = await harness.service.handle({ Type: "Timer" });
  assert.equal(result.counts.delivery_unknown, 1);
  assert.equal(harness.repository.jobs.get(job._id).status, "delivery_unknown");
  assert.equal(harness.repository.jobs.get(job._id).lastErrorCode, "LEASE_EXPIRED");
  assert.equal(harness.mailer.sends.length, 0);
  assert.equal(
    harness.repository.inquiries.get("inquiry_1").emailNotificationStatus,
    "delivery_unknown"
  );
});

await test("a later successful stage cannot hide an earlier delivery failure", async () => {
  const error = new Error("authentication rejected");
  error.code = "EAUTH";
  const harness = buildHarness({
    sendImpl: async (message) => {
      if (message.recipient === "primary@example.com") throw error;
      return { accepted: true };
    },
  });
  const first = await harness.service.handle({
    action: "kick",
    inquiryId: "inquiry_1",
  });
  assert.equal(first.counts.permanent_failed, 1);
  assert.equal(first.counts.sent, 1);
  assert.equal(
    harness.repository.inquiries.get("inquiry_1").emailNotificationStatus,
    "permanent_failed"
  );

  harness.clock += 5 * 60 * 1000;
  const escalation = await harness.service.handle({ Type: "Timer" });
  assert.equal(escalation.counts.sent, 1);
  assert.equal(
    harness.repository.inquiries.get("inquiry_1").emailNotificationStatus,
    "permanent_failed"
  );
});

await test("outbound mail excludes every customer field", async () => {
  const harness = buildHarness({
    inquiry: {
      _id: "raw-inquiry-secret",
      status: "new",
      createdAt: new Date("2026-08-21T00:00:00.000Z"),
      contact: "secret-customer@example.com",
      contactType: "email",
      content: "secret custom requirement",
      openid: "secret-openid",
      caseTitle: "secret-case-title",
    },
  });
  await harness.service.handle({ action: "kick", inquiryId: "raw-inquiry-secret" });
  assert.equal(harness.mailer.sends.length, 2);
  harness.mailer.sends.forEach((outbound) => {
    const content = JSON.stringify({
      subject: outbound.subject,
      text: outbound.text,
      reference: outbound.reference,
      messageId: outbound.messageId,
    });
    for (const secret of [
      "raw-inquiry-secret",
      "secret-customer@example.com",
      "secret custom requirement",
      "secret-openid",
      "secret-case-title",
    ]) {
      assert.equal(content.includes(secret), false);
    }
  });
  assert.deepEqual(
    harness.mailer.sends.map((outbound) => outbound.recipient).sort(),
    ["primary-2@example.com", "primary@example.com"]
  );
});

await test("lease duration is bounded and longer than SMTP socket timeout", () => {
  assert.equal(JOB_LEASE_MS, 120_000);
});

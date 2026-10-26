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
  createSmtpAdapter,
  getSmtpConfigurationStatus,
} = require(resolve(notifierPath, "smtpAdapter.js"));

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

const ENABLED_ENV = Object.freeze({
  INQUIRY_EMAIL_ALERTS_ENABLED: "true",
  INQUIRY_NOTIFY_PRIMARY_EMAIL: "primary@example.com",
  INQUIRY_NOTIFY_PRIMARY_EMAIL_2: "primary-2@example.com",
  INQUIRY_NOTIFY_BACKUP_EMAIL: "backup@example.com",
});

await test("internal tokens require an exact non-empty constant-time comparison", () => {
  const token = "notifier-internal-token-20260821";
  assert.equal(logic.isValidInternalToken(token, token), true);
  assert.equal(logic.isValidInternalToken(token, `${token}-wrong`), false);
  assert.equal(logic.isValidInternalToken(token, ` ${token}`), false);
  assert.equal(logic.isValidInternalToken("", ""), false);
  assert.equal(logic.isValidInternalToken(token, undefined), false);
});

await test("inquiry email aggregation keeps failures visible", () => {
  assert.equal(logic.resolveInquiryEmailStatus("", "cancelled"), "cancelled");
  assert.equal(logic.resolveInquiryEmailStatus("cancelled", "sent"), "sent");
  assert.equal(logic.resolveInquiryEmailStatus("sent", "cancelled"), "sent");
  assert.equal(logic.resolveInquiryEmailStatus("sent", "failed"), "failed");
  assert.equal(
    logic.resolveInquiryEmailStatus("permanent_failed", "sent"),
    "permanent_failed"
  );
  assert.equal(
    logic.resolveInquiryEmailStatus("delivery_unknown", "cancelled"),
    "delivery_unknown"
  );
});

await test("creates deterministic independent jobs for two primaries and backup", () => {
  assert.equal(logic.PLAN_VERSION, "email-v1");
  const submittedAt = Date.parse("2026-08-21T00:00:00.000Z");
  const first = logic.buildStageJobs({
    _id: "raw_inquiry_identifier",
    createdAt: new Date(submittedAt),
    source: "detail",
  });
  const second = logic.buildStageJobs({
    _id: "raw_inquiry_identifier",
    createdAt: new Date(submittedAt),
  });

  assert.deepEqual(
    first.map((job) => [job.stageKey, job.recipientRole, job.dueAt.getTime()]),
    [
      ["primary_immediate", "primary", submittedAt],
      ["primary_2_immediate", "primary_2", submittedAt],
      ["backup_5m", "backup", submittedAt + 5 * 60 * 1000],
      ["primary_15m", "primary", submittedAt + 15 * 60 * 1000],
      ["primary_2_15m", "primary_2", submittedAt + 15 * 60 * 1000],
      ["backup_15m", "backup", submittedAt + 15 * 60 * 1000],
    ]
  );
  assert.deepEqual(first.map((job) => job._id), second.map((job) => job._id));
  assert.equal(first.every((job) => job._id.length === 32), true);
  assert.equal(first.some((job) => job._id.includes("raw_inquiry_identifier")), false);
  assert.equal(first.every((job) => job.submittedAt.getTime() === submittedAt), true);
  assert.equal(first.every((job) => job.inquirySource === "detail"), true);
});

await test("stops after claim, first reply, or leaving the new status", () => {
  assert.equal(logic.getInquiryStopReason({ status: "new" }), "");
  assert.equal(logic.getInquiryStopReason({ status: "new", claimedBy: "admin" }), "claimed");
  assert.equal(logic.getInquiryStopReason({ status: "new", claimedByOpenid: "admin" }), "claimed");
  assert.equal(logic.getInquiryStopReason({ status: "new", claimedAt: new Date() }), "claimed");
  assert.equal(logic.getInquiryStopReason({ status: "new", firstReplyAt: new Date() }), "replied");
  assert.equal(logic.getInquiryStopReason({ status: "new", repliedAt: new Date() }), "replied");
  assert.equal(logic.getInquiryStopReason({ status: "new", lastAdminReplyAt: new Date() }), "replied");
  assert.equal(logic.getInquiryStopReason({ status: "new", replyCount: 1 }), "replied");
  assert.equal(logic.getInquiryStopReason({ status: "contacted" }), "claimed");
  assert.equal(logic.getInquiryStopReason({ status: "processing" }), "claimed");
  assert.equal(logic.getInquiryStopReason({ status: "done" }), "inquiry_closed");
  assert.equal(logic.getInquiryStopReason({ status: "invalid" }), "inquiry_closed");
  assert.equal(logic.getInquiryStopReason(null), "inquiry_missing");
});

await test("only due jobs can be claimed and an expired lease is ambiguous", () => {
  const now = 10_000;
  assert.equal(logic.getJobAction({
    _id: "a",
    status: "pending",
    dueAt: new Date(now),
  }, now), "claim");
  assert.equal(logic.getJobAction({
    _id: "a",
    status: "pending",
    dueAt: new Date(now + 1),
  }, now), "");
  assert.equal(logic.getJobAction({
    _id: "a",
    status: "retry",
    nextAttemptAt: new Date(now),
  }, now), "claim");
  assert.equal(logic.getJobAction({
    _id: "a",
    status: "processing",
    leaseUntil: new Date(now - 1),
  }, now), "recover_unknown");
  assert.equal(logic.getJobAction({
    _id: "a",
    status: "sent",
  }, now), "");
});

await test("uses exactly 30 second, 2 minute, and 5 minute retries", () => {
  assert.deepEqual(logic.RETRY_DELAYS_MS, [30_000, 120_000, 300_000]);
  assert.equal(logic.getRetryDelayMs(1), 30_000);
  assert.equal(logic.getRetryDelayMs(2), 120_000);
  assert.equal(logic.getRetryDelayMs(3), 300_000);
  assert.equal(logic.getRetryDelayMs(4), null);
});

await test("classifies permanent, transient, and timeout SMTP failures", () => {
  assert.deepEqual(logic.classifyDeliveryError({ code: "EAUTH" }), {
    category: "permanent",
    code: "EAUTH",
  });
  assert.deepEqual(logic.classifyDeliveryError({ responseCode: 550 }), {
    category: "permanent",
    code: "SMTP_550",
  });
  assert.deepEqual(logic.classifyDeliveryError({ code: "ECONNRESET" }), {
    category: "transient",
    code: "ECONNRESET",
  });
  assert.deepEqual(logic.classifyDeliveryError({ responseCode: 421 }), {
    category: "transient",
    code: "SMTP_421",
  });
  assert.deepEqual(logic.classifyDeliveryError({ code: "ETIMEDOUT" }), {
    category: "timeout",
    code: "ETIMEDOUT",
  });
  assert.deepEqual(logic.classifyDeliveryError({ code: "account-secret-value" }), {
    category: "transient",
    code: "SMTP_UNKNOWN",
  });
});

await test("feature flag defaults off and requires three distinct admin recipients", () => {
  assert.deepEqual(logic.getNotifierConfiguration({}), {
    enabled: false,
    ready: false,
    reason: "feature_disabled",
    recipients: {},
  });
  assert.equal(logic.getNotifierConfiguration({
    INQUIRY_EMAIL_ALERTS_ENABLED: "true",
  }).ready, false);
  assert.equal(logic.getNotifierConfiguration({
    ...ENABLED_ENV,
    INQUIRY_NOTIFY_BACKUP_EMAIL: "primary@example.com",
  }).ready, false);
  assert.equal(logic.getNotifierConfiguration({
    ...ENABLED_ENV,
    INQUIRY_NOTIFY_PRIMARY_EMAIL_2: "",
  }).ready, false);
  assert.equal(logic.getNotifierConfiguration({
    ...ENABLED_ENV,
    INQUIRY_NOTIFY_PRIMARY_EMAIL_2: "PRIMARY@example.com",
  }).ready, false);
  assert.equal(logic.getNotifierConfiguration({
    ...ENABLED_ENV,
    INQUIRY_NOTIFY_PRIMARY_EMAIL_2: "backup@example.com",
  }).ready, false);
  assert.deepEqual(logic.getNotifierConfiguration(ENABLED_ENV).recipients, {
    primary: "primary@example.com",
    primary_2: "primary-2@example.com",
    backup: "backup@example.com",
  });
  assert.equal(logic.isNotifierEnabled({ INQUIRY_NOTIFIER_ENABLED: "true" }), true);
  assert.equal(logic.isNotifierEnabled({
    INQUIRY_EMAIL_ALERTS_ENABLED: "false",
    INQUIRY_NOTIFIER_ENABLED: "true",
  }), false);
});

await test("mail body contains no inquiry PII or raw inquiry identifier", () => {
  const [job] = logic.buildStageJobs({
    _id: "inquiry_with_customer_secret",
    contact: "customer_wechat_secret",
    content: "customer_requirement_secret",
    openid: "customer_openid_secret",
    createdAt: new Date(0),
  });
  const message = logic.buildSafeMail({
    ...job,
    contact: "customer_wechat_secret",
    content: "customer_requirement_secret",
  });
  const serialized = JSON.stringify(message);
  assert.equal(serialized.includes("customer_wechat_secret"), false);
  assert.equal(serialized.includes("customer_requirement_secret"), false);
  assert.equal(serialized.includes("customer_openid_secret"), false);
  assert.equal(serialized.includes("inquiry_with_customer_secret"), false);
  assert.match(message.text, /本邮件不包含客户联系方式或需求内容/);
});

await test("mail includes only the safe submission time and normalized source", () => {
  const [job] = logic.buildStageJobs({
    _id: "inquiry_1",
    source: "detail",
    createdAt: new Date("2026-08-21T00:00:00.000Z"),
  });
  const message = logic.buildSafeMail(job);
  assert.match(message.text, /需求编号：REQ-[A-F0-9]{8}/);
  assert.match(message.text, /提交时间：2026-08-21 08:00 北京时间/);
  assert.match(message.text, /来源：案例详情/);

  const [unknownSourceJob] = logic.buildStageJobs({
    _id: "inquiry_2",
    source: "customer-secret-source",
    createdAt: new Date("2026-08-21T00:00:00.000Z"),
  });
  const unknownSourceMessage = logic.buildSafeMail(unknownSourceJob);
  assert.match(unknownSourceMessage.text, /来源：其他入口/);
  assert.equal(unknownSourceMessage.text.includes("customer-secret-source"), false);
});

await test("missing SMTP configuration disables safely without loading a transport", async () => {
  let factoryCalls = 0;
  const adapter = createSmtpAdapter({
    env: ENABLED_ENV,
    transportFactory() {
      factoryCalls += 1;
      throw new Error("must not be called");
    },
  });
  assert.deepEqual(adapter.getStatus(), {
    ready: false,
    reason: "smtp_not_configured",
  });
  assert.equal(factoryCalls, 0);
  await assert.rejects(adapter.send({}), (error) => error.code === "MAIL_DISABLED");
});

await test("SMTP adapter keeps credentials out of status and result objects", async () => {
  const secret = "smtp-password-secret";
  let transportOptions;
  let sentMessage;
  const env = {
    ...ENABLED_ENV,
    INQUIRY_SMTP_HOST: "smtp.example.com",
    INQUIRY_SMTP_PORT: "465",
    INQUIRY_SMTP_USER: "smtp-user@example.com",
    INQUIRY_SMTP_PASS: secret,
    INQUIRY_SMTP_FROM: "notifier@example.com",
  };
  const adapter = createSmtpAdapter({
    env,
    transportFactory(options) {
      transportOptions = options;
      return {
        async sendMail(message) {
          sentMessage = message;
          return { accepted: [message.to], messageId: "provider-id" };
        },
      };
    },
  });
  const result = await adapter.send({
    recipient: "primary@example.com",
    subject: "safe subject",
    text: "safe text",
    messageId: "<safe@local>",
    reference: "abc123",
  });

  assert.equal(transportOptions.auth.pass, secret);
  assert.equal(transportOptions.secure, true);
  assert.equal(transportOptions.requireTLS, false);
  assert.equal(sentMessage.to, "primary@example.com");
  assert.deepEqual(result, { accepted: true });
  assert.equal(JSON.stringify(adapter.getStatus()).includes(secret), false);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(getSmtpConfigurationStatus(env), {
    enabled: true,
    ready: true,
    reason: "",
  });
  assert.equal(getSmtpConfigurationStatus({
    ...env,
    INQUIRY_SMTP_SECURE: "not-a-boolean",
  }).ready, false);
});

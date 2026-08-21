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
  INQUIRY_COLLECTION,
  JOB_COLLECTION,
  createCloudbaseRepository,
} = require(resolve(notifierPath, "cloudbaseRepository.js"));

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function matches(record, condition = {}) {
  return Object.entries(condition).every(([key, expected]) => {
    if (expected && expected.operator === "in") {
      return expected.values.includes(record[key]);
    }
    if (expected && expected.operator === "gte") {
      return logic.toTimestamp(record[key]) >= logic.toTimestamp(expected.value);
    }
    if (expected && expected.operator === "lte") {
      return logic.toTimestamp(record[key]) <= logic.toTimestamp(expected.value);
    }
    return record[key] === expected;
  });
}

function createFakeDatabase(initial = {}) {
  const collections = Object.fromEntries(
    Object.entries(initial).map(([name, records]) => [name, clone(records)])
  );

  function collection(name) {
    const records = collections[name] || (collections[name] = []);
    const query = {
      condition: null,
      orderField: "",
      orderDirection: "asc",
      limitValue: Infinity,
    };
    return {
      where(condition) {
        query.condition = condition;
        return this;
      },
      orderBy(field, direction) {
        query.orderField = field;
        query.orderDirection = direction;
        return this;
      },
      limit(value) {
        query.limitValue = value;
        return this;
      },
      async get() {
        let result = query.condition
          ? records.filter((record) => matches(record, query.condition))
          : records.slice();
        if (query.orderField) {
          const direction = query.orderDirection === "desc" ? -1 : 1;
          result = result.slice().sort((left, right) => (
            logic.toTimestamp(left[query.orderField])
            - logic.toTimestamp(right[query.orderField])
          ) * direction);
        }
        return { data: clone(result.slice(0, query.limitValue)) };
      },
      doc(id) {
        return {
          async get() {
            const record = records.find((item) => item._id === id);
            if (!record) {
              const error = new Error("document not found");
              error.code = "DATABASE_DOCUMENT_NOT_EXIST";
              throw error;
            }
            return { data: clone(record) };
          },
          async set(payload) {
            const record = { _id: id, ...clone(payload.data || {}) };
            const index = records.findIndex((item) => item._id === id);
            if (index === -1) records.push(record);
            else records[index] = record;
            return {};
          },
          async update(payload) {
            const record = records.find((item) => item._id === id);
            if (!record) throw new Error("document not found");
            Object.assign(record, clone(payload.data || {}));
            return {};
          },
        };
      },
    };
  }

  const db = {
    command: {
      in(values) {
        return { operator: "in", values };
      },
      gte(value) {
        return { operator: "gte", value };
      },
      lte(value) {
        return { operator: "lte", value };
      },
    },
    collection,
    serverDate() {
      return new Date();
    },
    async runTransaction(handler) {
      return handler({ collection });
    },
  };
  return { collections, db };
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

await test("deterministic job document makes repeated scheduling idempotent", async () => {
  const { db, collections } = createFakeDatabase();
  const repository = createCloudbaseRepository(db);
  const [job] = logic.buildStageJobs({
    _id: "inquiry_1",
    status: "new",
    createdAt: new Date(1000),
  });
  assert.equal((await repository.ensureJob(job)).created, true);
  assert.equal((await repository.ensureJob(job)).created, false);
  assert.equal(collections[JOB_COLLECTION].length, 1);
  assert.equal(collections[JOB_COLLECTION][0].inquiryId, "inquiry_1");
  assert.equal(
    logic.toTimestamp(collections[JOB_COLLECTION][0].submittedAt),
    1000
  );
  assert.equal("recipient" in collections[JOB_COLLECTION][0], false);
});

await test("transactional lease allows only one worker to claim", async () => {
  const { db, collections } = createFakeDatabase();
  const repository = createCloudbaseRepository(db);
  const [job] = logic.buildStageJobs({
    _id: "inquiry_1",
    createdAt: new Date(1000),
  });
  await repository.ensureJob(job);
  const first = await repository.claimJob(job._id, "worker_1", 1000, 120_000);
  const second = await repository.claimJob(job._id, "worker_2", 1000, 120_000);
  assert.equal(first.disposition, "claimed");
  assert.equal(second.disposition, "busy");
  assert.equal(collections[JOB_COLLECTION][0].attempt, 1);
  assert.equal(collections[JOB_COLLECTION][0].leaseOwner, "worker_1");
});

await test("only the current lease owner can finalize a processing job", async () => {
  const { db, collections } = createFakeDatabase({
    [INQUIRY_COLLECTION]: [{ _id: "inquiry_1", status: "new" }],
  });
  const repository = createCloudbaseRepository(db);
  const [job] = logic.buildStageJobs({
    _id: "inquiry_1",
    createdAt: new Date(1000),
  });
  await repository.ensureJob(job);
  await repository.claimJob(job._id, "worker_1", 1000, 120_000);
  assert.equal(await repository.finishJob(job._id, "worker_2", { status: "sent" }), false);
  assert.equal(await repository.finishJob(job._id, "worker_1", { status: "sent" }), true);
  assert.equal(collections[JOB_COLLECTION][0].status, "sent");
  assert.equal(collections[JOB_COLLECTION][0].leaseOwner, "");
  assert.equal(
    collections[INQUIRY_COLLECTION][0].emailNotificationStatus,
    "sent"
  );
  assert.equal(
    collections[INQUIRY_COLLECTION][0].emailNotificationUpdatedAt instanceof Date,
    true
  );
});

await test("inquiry email failure is sticky and stores no recipient or error detail", async () => {
  const inquiry = { _id: "inquiry_1", status: "new", contact: "private-contact" };
  const jobs = logic.buildStageJobs({
    _id: "inquiry_1",
    createdAt: new Date(1000),
  }).slice(0, 2).map((job) => ({
    ...job,
    status: "pending",
    leaseOwner: "",
    leaseUntil: null,
  }));
  const { db, collections } = createFakeDatabase({
    [INQUIRY_COLLECTION]: [inquiry],
    [JOB_COLLECTION]: jobs,
  });
  const repository = createCloudbaseRepository(db);

  await repository.claimJob(jobs[0]._id, "worker_1", 1000, 120_000);
  assert.equal(await repository.finishJob(jobs[0]._id, "worker_1", {
    status: "permanent_failed",
    lastErrorCategory: "permanent",
    lastErrorCode: "EAUTH",
    recipient: "must-not-leak@example.com",
  }), true);
  await repository.claimJob(jobs[1]._id, "worker_2", 1000, 120_000);
  assert.equal(await repository.finishJob(jobs[1]._id, "worker_2", {
    status: "sent",
  }), true);

  const updated = collections[INQUIRY_COLLECTION][0];
  assert.equal(updated.emailNotificationStatus, "permanent_failed");
  assert.equal(updated.lastErrorCategory, undefined);
  assert.equal(updated.lastErrorCode, undefined);
  assert.equal(updated.recipient, undefined);
  assert.equal(updated.contact, "private-contact");
});

await test("expired lease is terminal unknown and never handed to another sender", async () => {
  const now = 10_000;
  const [job] = logic.buildStageJobs({
    _id: "inquiry_1",
    createdAt: new Date(1000),
  });
  const { db, collections } = createFakeDatabase({
    [INQUIRY_COLLECTION]: [{ _id: "inquiry_1", status: "new" }],
    [JOB_COLLECTION]: [{
      ...job,
      status: "processing",
      attempt: 1,
      leaseOwner: "dead_worker",
      leaseUntil: new Date(now - 1),
    }],
  });
  const repository = createCloudbaseRepository(db);
  const recovered = await repository.claimJob(job._id, "worker_2", now, 120_000);
  assert.equal(recovered.disposition, "recovered_unknown");
  assert.equal(collections[JOB_COLLECTION][0].status, "delivery_unknown");
  assert.equal(collections[JOB_COLLECTION][0].lastErrorCode, "LEASE_EXPIRED");
  assert.equal(
    collections[INQUIRY_COLLECTION][0].emailNotificationStatus,
    "delivery_unknown"
  );
  assert.equal((await repository.claimJob(job._id, "worker_3", now, 120_000)).disposition, "busy");
});

await test("due jobs are not crowded out by future pending stages", async () => {
  const now = 10_000;
  const futureJobs = Array.from({ length: 120 }, (_, index) => ({
    _id: `future_${index}`,
    status: "pending",
    dueAt: new Date(now + 60_000 + index),
  }));
  const dueJob = {
    _id: "due_now",
    status: "pending",
    dueAt: new Date(now),
  };
  const { db } = createFakeDatabase({
    [JOB_COLLECTION]: futureJobs.concat(dueJob),
  });
  const repository = createCloudbaseRepository(db);
  const jobs = await repository.listActionableJobs(now, 20, 100);
  assert.deepEqual(jobs.map((job) => job._id), ["due_now"]);
});

await test("pending inquiry queue is oldest-first and records its scheduling state", async () => {
  const { db, collections } = createFakeDatabase({
    [INQUIRY_COLLECTION]: [
      { _id: "newer", alertTaskStatus: "pending", createdAt: new Date(2000) },
      { _id: "oldest", alertTaskStatus: "pending", createdAt: new Date(1000) },
      { _id: "done", alertTaskStatus: "scheduled", createdAt: new Date(500) },
    ],
  });
  const repository = createCloudbaseRepository(db);
  const pending = await repository.listPendingInquiries(1);
  assert.deepEqual(pending.map((item) => item._id), ["oldest"]);
  await repository.markInquiryAlertState("oldest", {
    status: "scheduled",
    planVersion: logic.PLAN_VERSION,
  });
  const updated = collections[INQUIRY_COLLECTION].find((item) => item._id === "oldest");
  assert.equal(updated.alertTaskStatus, "scheduled");
  assert.equal(updated.alertTaskPlanVersion, logic.PLAN_VERSION);
});

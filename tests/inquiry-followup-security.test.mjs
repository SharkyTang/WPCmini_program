import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cloudbaseRoot = resolve(__dirname, "../miniprogram/cloudbase");
const functionConfig = JSON.parse(readFileSync(
  resolve(__dirname, "../cloudbaserc.json"),
  "utf8"
));
const notifierConfig = functionConfig.functions.find(
  (item) => item.name === "inquiryNotifier"
);
assert.equal(notifierConfig.timeout, 60);
assert.equal(notifierConfig.runtime, "Nodejs16.13");

const userDataOpenapiConfig = JSON.parse(readFileSync(
  resolve(__dirname, "../miniprogram/cloudfunctions/userData/config.json"),
  "utf8"
));
assert.deepEqual(userDataOpenapiConfig.permissions?.openapi, [
  "subscribeMessage.getTemplateList",
]);

const inquiryAdminOpenapiConfig = JSON.parse(readFileSync(
  resolve(__dirname, "../miniprogram/cloudfunctions/inquiryAdmin/config.json"),
  "utf8"
));
assert.deepEqual(inquiryAdminOpenapiConfig.permissions?.openapi, [
  "subscribeMessage.send",
]);

for (const collection of [
  "user_profiles",
  "inquiries",
  "inquiry_messages",
  "inquiry_alert_jobs",
  "inquiry_reply_subscriptions",
  "inquiry_admin_events",
]) {
  const rules = JSON.parse(readFileSync(
    resolve(cloudbaseRoot, `${collection}.rules.json`),
    "utf8"
  ));
  assert.deepEqual(rules, { read: false, write: false });
}

const profileIndexes = JSON.parse(readFileSync(
  resolve(cloudbaseRoot, "user_profiles.indexes.json"),
  "utf8"
));
assert.deepEqual(profileIndexes.user_profiles, [
  {
    name: "openid_1_unique",
    unique: true,
    fields: [{ field: "openid", order: "asc" }],
  },
]);

const functionRules = JSON.parse(readFileSync(
  resolve(cloudbaseRoot, "inquiryNotifier.function-rule-merge.json"),
  "utf8"
));
assert.deepEqual(Object.keys(functionRules), ["inquiryNotifier"]);
assert.equal(functionRules.inquiryNotifier.invoke, false);

const indexes = JSON.parse(readFileSync(
  resolve(cloudbaseRoot, "inquiry-followup.indexes.json"),
  "utf8"
));
assert.equal(
  indexes.inquiries.some((index) => index.name === "alertTaskStatus_createdAt"),
  true
);

function indexFields(name) {
  const index = indexes.inquiries.find((item) => item.name === name);
  return index ? index.fields : null;
}

assert.deepEqual(indexFields("claimedBy_status_createdAt_id"), [
  { field: "claimedByOpenid", order: "asc" },
  { field: "status", order: "asc" },
  { field: "createdAt", order: "desc" },
  { field: "_id", order: "desc" },
]);
assert.deepEqual(indexFields("claimedByOpenid_claimedBy_createdAt_id"), [
  { field: "claimedByOpenid", order: "asc" },
  { field: "claimedBy", order: "asc" },
  { field: "createdAt", order: "desc" },
  { field: "_id", order: "desc" },
]);
assert.deepEqual(indexFields("claimedByOpenid_claimedBy_status_createdAt_id"), [
  { field: "claimedByOpenid", order: "asc" },
  { field: "claimedBy", order: "asc" },
  { field: "status", order: "asc" },
  { field: "createdAt", order: "desc" },
  { field: "_id", order: "desc" },
]);

console.log("ok - inquiry follow-up collections and internal notifier are client-private");

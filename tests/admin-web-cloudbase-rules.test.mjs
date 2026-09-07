import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readRule(name) {
  return JSON.parse(
    readFileSync(
      resolve(process.cwd(), "admin-web", "cloudbase", `${name}.rules.json`),
      "utf8",
    ),
  );
}

const activity = readRule("case_admin_activity_feed");
assert.equal(activity.read, "doc.viewerUid == auth.uid");
assert.equal(activity.write, false);

for (const collection of [
  "case_admin_upload_jobs",
  "case_admin_purge_jobs",
  "case_admin_video_upload_intents",
]) {
  const rule = readRule(collection);
  assert.deepEqual(rule, { read: false, write: false });
}

const storageVideoTemplate = JSON.parse(
  readFileSync(
    resolve(
      process.cwd(),
      "admin-web",
      "cloudbase",
      "storage-video.rules.template.json",
    ),
    "utf8",
  ),
);
assert.match(storageVideoTemplate.read, /resource\.openid == auth\.openid/);
assert.match(storageVideoTemplate.read, /resource\.openid == auth\.uid/);
assert.match(storageVideoTemplate.write, /wine-packaging\\\/videos/);
assert.match(storageVideoTemplate.write, /__CASE_ADMIN_OPENID__/);
assert.match(storageVideoTemplate.write, /__CASE_ADMIN_UID__/);

console.log("ok - admin collaboration collections are client read-only or private");

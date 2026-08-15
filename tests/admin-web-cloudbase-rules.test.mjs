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

for (const collection of ["case_admin_upload_jobs", "case_admin_purge_jobs"]) {
  const rule = readRule(collection);
  assert.deepEqual(rule, { read: false, write: false });
}

console.log("ok - admin collaboration collections are client read-only or private");

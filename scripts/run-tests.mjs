import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

const testsDirectory = resolve(process.cwd(), "tests");
const testFiles = readdirSync(testsDirectory)
  .filter((fileName) => fileName.endsWith(".test.mjs"))
  .sort();

if (!testFiles.length) {
  console.error("No test files found in tests/*.test.mjs");
  process.exit(1);
}

for (const fileName of testFiles) {
  const result = spawnSync(process.execPath, [resolve(testsDirectory, fileName)], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`all ${testFiles.length} test files passed`);

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_ENV_ID = "cloud1-d3gznsms746425a42";
const DEFAULT_COLLECTIONS = ["wine_packaging", "home_banners", "catalog_meta"];
const PAGE_SIZE = 100;

function parseEnvFile(content) {
  return content.split(/\r?\n/).reduce((env, line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return env;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex < 1) return env;
    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
    return env;
  }, {});
}

function loadLocalEnv(envPath = ".env.local") {
  if (!existsSync(envPath)) return;
  const env = parseEnvFile(readFileSync(envPath, "utf8"));
  for (const [key, value] of Object.entries(env)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function formatTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

async function fetchCollection(db, collectionName) {
  const records = [];
  let offset = 0;
  while (true) {
    const response = await db
      .collection(collectionName)
      .skip(offset)
      .limit(PAGE_SIZE)
      .get();
    const page = Array.isArray(response.data) ? response.data : [];
    records.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return records;
}

async function main() {
  loadLocalEnv();
  const secretId = process.env.TENCENTCLOUD_SECRET_ID;
  const secretKey = process.env.TENCENTCLOUD_SECRET_KEY;
  if (!secretId || !secretKey) {
    throw new Error("缺少腾讯云凭证，请配置 .env.local 后重试");
  }

  const envId = process.argv[2] || DEFAULT_ENV_ID;
  const outputDir = resolve("backups", `cloudbase-${envId}-${formatTimestamp()}`);
  mkdirSync(outputDir, { recursive: true });

  const { default: cloudbase } = await import("@cloudbase/node-sdk");
  const app = cloudbase.init({ env: envId, secretId, secretKey });
  const db = app.database();
  const manifest = {
    envId,
    createdAt: new Date().toISOString(),
    collections: {},
  };

  for (const collectionName of DEFAULT_COLLECTIONS) {
    const records = await fetchCollection(db, collectionName);
    const filename = `${collectionName}.json`;
    writeFileSync(
      resolve(outputDir, filename),
      `${JSON.stringify(records, null, 2)}\n`,
      "utf8"
    );
    manifest.collections[collectionName] = {
      filename,
      count: records.length,
    };
  }

  const catalogMeta = manifest.collections.catalog_meta;
  const catalogMetaRecords = JSON.parse(
    readFileSync(resolve(outputDir, catalogMeta.filename), "utf8")
  );
  const currentMeta = catalogMetaRecords.find((record) => record._id === "current") || null;
  writeFileSync(
    resolve(outputDir, "catalog_meta-current.json"),
    `${JSON.stringify(currentMeta, null, 2)}\n`,
    "utf8"
  );
  manifest.catalogMetaCurrentFound = Boolean(currentMeta);
  writeFileSync(
    resolve(outputDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );

  console.log(`CloudBase 备份完成：${outputDir}`);
  for (const [name, info] of Object.entries(manifest.collections)) {
    console.log(`- ${name}: ${info.count} 条`);
  }
  console.log(`- catalog_meta/current: ${currentMeta ? "已记录" : "未找到"}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});

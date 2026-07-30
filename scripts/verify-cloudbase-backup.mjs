import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sha256 } from "./backup-cloudbase-data.mjs";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function verifyBackupDirectory(directory) {
  const backupDirectory = resolve(directory);
  const manifestPath = resolve(backupDirectory, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`找不到备份清单：${manifestPath}`);
  }

  const manifest = readJson(manifestPath);
  const checks = [];
  for (const [collection, info] of Object.entries(manifest.collections || {})) {
    const filePath = resolve(backupDirectory, info.filename);
    if (!existsSync(filePath)) throw new Error(`缺少集合备份：${info.filename}`);
    const content = readFileSync(filePath);
    const records = JSON.parse(content.toString("utf8"));
    if (!Array.isArray(records)) throw new Error(`${info.filename} 不是 JSON 数组`);
    if (records.length !== info.count) {
      throw new Error(
        `${collection} 数量不一致：清单 ${info.count}，文件 ${records.length}`
      );
    }
    const actualChecksum = sha256(content);
    if (actualChecksum !== info.sha256) {
      throw new Error(`${info.filename} SHA-256 校验失败`);
    }
    checks.push({ name: collection, count: records.length, sha256: actualChecksum });
  }

  for (const info of [manifest.catalogMetaCurrent, manifest.storageFiles].filter(Boolean)) {
    const filePath = resolve(backupDirectory, info.filename);
    if (!existsSync(filePath)) throw new Error(`缺少备份文件：${info.filename}`);
    const content = readFileSync(filePath);
    const actualChecksum = sha256(content);
    if (actualChecksum !== info.sha256) {
      throw new Error(`${info.filename} SHA-256 校验失败`);
    }
  }

  const storageManifest = manifest.storageFiles
    ? readJson(resolve(backupDirectory, manifest.storageFiles.filename))
    : { files: [] };
  const storageFileCount = Array.isArray(storageManifest.files)
    ? storageManifest.files.length
    : 0;
  if (
    manifest.storageFiles &&
    storageFileCount !== manifest.storageFiles.count
  ) {
    throw new Error(
      `云文件清单数量不一致：清单 ${manifest.storageFiles.count}，文件 ${storageFileCount}`
    );
  }

  return {
    backupDirectory,
    envId: manifest.envId || "",
    createdAt: manifest.createdAt || "",
    collections: checks,
    storageFileCount,
  };
}

function main() {
  const argument = process.argv[2];
  if (!argument || argument === "--help" || argument === "-h") {
    console.log("用法: npm run backup:verify -- <backup-directory>");
    return;
  }
  const result = verifyBackupDirectory(argument);
  console.log(`备份校验通过：${result.backupDirectory}`);
  for (const item of result.collections) {
    console.log(`- ${item.name}: ${item.count} 条`);
  }
  console.log(`- 云文件引用：${result.storageFileCount} 个`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  }
}

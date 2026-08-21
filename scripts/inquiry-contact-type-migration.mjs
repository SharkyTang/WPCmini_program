import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  parseEnvFile,
  validateBackupManifest,
} from "./backup-cloudbase-data.mjs";
import {
  CONTACT_TYPE_SOURCE,
  INQUIRY_COLLECTION,
  MAX_BATCH_SIZE,
  runInquiryContactTypeMigration,
} from "./inquiry-contact-type-migration-logic.mjs";

const APPLY_CONFIRMATION = "APPLY_INQUIRY_CONTACT_TYPE_MIGRATION";
const REPORT_SCHEMA_VERSION = 1;

function formatTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function readRequiredValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${optionName} 需要参数值`);
  }
  return value;
}

function parsePositiveInteger(value, optionName, { allowZero = false } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < (allowZero ? 0 : 1)) {
    throw new Error(`${optionName} 必须是${allowZero ? "非负" : "正"}整数`);
  }
  return number;
}

function parseMigrationArgs(argv = process.argv.slice(2), now = new Date()) {
  const options = {
    apply: false,
    backupDir: "",
    batchSize: 20,
    confirmEnv: "",
    confirmWrite: "",
    envId: "",
    help: false,
    limit: 0,
    reportPath: "",
    reportExplicit: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--env") {
      options.envId = readRequiredValue(argv, index, "--env");
      index += 1;
    } else if (argument === "--report") {
      options.reportPath = resolve(readRequiredValue(argv, index, "--report"));
      options.reportExplicit = true;
      index += 1;
    } else if (argument === "--backup") {
      options.backupDir = resolve(readRequiredValue(argv, index, "--backup"));
      index += 1;
    } else if (argument === "--batch-size") {
      options.batchSize = parsePositiveInteger(
        readRequiredValue(argv, index, "--batch-size"),
        "--batch-size"
      );
      if (options.batchSize > MAX_BATCH_SIZE) {
        throw new Error(`--batch-size 不能超过 ${MAX_BATCH_SIZE}`);
      }
      index += 1;
    } else if (argument === "--limit") {
      options.limit = parsePositiveInteger(
        readRequiredValue(argv, index, "--limit"),
        "--limit",
        { allowZero: true }
      );
      index += 1;
    } else if (argument === "--apply") {
      options.apply = true;
    } else if (argument === "--confirm-env") {
      options.confirmEnv = readRequiredValue(argv, index, "--confirm-env");
      index += 1;
    } else if (argument === "--confirm-write") {
      options.confirmWrite = readRequiredValue(argv, index, "--confirm-write");
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }

  if (!options.reportPath) {
    options.reportPath = resolve(
      "backups",
      `inquiry-contact-type-migration-${formatTimestamp(now)}.json`
    );
  }
  return options;
}

function validateMigrationOptions(options) {
  if (options.help) return options;
  if (!options.envId) {
    throw new Error("必须显式提供 --env，不使用隐式生产环境");
  }
  if (!options.apply) return options;
  if (options.confirmEnv !== options.envId) {
    throw new Error("--confirm-env 必须与 --env 完全一致");
  }
  if (options.confirmWrite !== APPLY_CONFIRMATION) {
    throw new Error(`--confirm-write 必须为 ${APPLY_CONFIRMATION}`);
  }
  if (!options.backupDir) {
    throw new Error("正式写入前必须通过 --backup 提供已校验的 CloudBase 备份目录");
  }
  if (!options.reportExplicit) {
    throw new Error("正式写入必须通过 --report 显式指定审计报告路径");
  }
  return options;
}

function loadLocalEnv(envPath = resolve(".env.local")) {
  if (!existsSync(envPath)) return;
  const localValues = parseEnvFile(readFileSync(envPath, "utf8"));
  for (const [key, value] of Object.entries(localValues)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

async function createCloudbaseDatabase(envId) {
  loadLocalEnv();
  const secretId = process.env.TENCENTCLOUD_SECRET_ID;
  const secretKey = process.env.TENCENTCLOUD_SECRET_KEY;
  if (!secretId || !secretKey) {
    throw new Error("缺少腾讯云凭证，请在 .env.local 配置 TENCENTCLOUD_SECRET_ID 和 TENCENTCLOUD_SECRET_KEY");
  }
  const { default: cloudbase } = await import("@cloudbase/node-sdk");
  return cloudbase.init({ env: envId, secretId, secretKey }).database();
}

function writePrivateReport(reportPath, report) {
  const directory = dirname(reportPath);
  const directoryAlreadyExists = existsSync(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Do not chmod a caller-owned parent such as /private/tmp or an existing
  // backup root. A newly created report directory is private, while the
  // report itself is always forced to 0600 below.
  if (!directoryAlreadyExists) chmodSync(directory, 0o700);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(reportPath, 0o600);
}

function buildAuditReport(result, options, now = new Date()) {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    envId: options.envId,
    collection: INQUIRY_COLLECTION,
    mode: result.mode,
    rules: {
      validExistingContactType: "skip",
      strictEmail: "email",
      strictMainlandPhone: "phone",
      otherNonemptyContact: "wechat",
      emptyContact: "skip_unknown",
      inferredSourceField: "contactTypeSource",
      inferredSourceValue: CONTACT_TYPE_SOURCE,
    },
    safeguards: {
      documentKey: "_id",
      transactionPreconditions: [
        "contact_unchanged",
        "contactType_still_empty",
      ],
      batchSize: options.batchSize,
      limit: options.limit,
      backupDir: options.apply ? options.backupDir : null,
    },
    summary: result.summary,
    entries: result.entries,
  };
}

function verifyApplyBackup(options) {
  if (!options.apply) return null;
  const verification = validateBackupManifest(options.backupDir);
  if (verification.envId !== options.envId) {
    throw new Error("备份环境与 --env 不一致，禁止写入");
  }
  return verification;
}

function printHelp() {
  console.log(`需求联系方式历史数据迁移

默认为只读 dry-run：
  node scripts/inquiry-contact-type-migration.mjs \\
    --env <envId> \\
    --report backups/inquiry-contact-type-dry-run.json

正式写入（缺少任一确认参数都会拒绝执行）：
  node scripts/inquiry-contact-type-migration.mjs \\
    --env <envId> \\
    --backup backups/cloudbase-<envId>-<time> \\
    --report backups/inquiry-contact-type-apply.json \\
    --batch-size 20 \\
    --apply \\
    --confirm-env <envId> \\
    --confirm-write ${APPLY_CONFIRMATION}

选项：
  --env <envId>          必填，不默认指向生产
  --report <path>        前后变更报告；正式写入时必须显式提供
  --batch-size <n>       每批并发数，默认 20，内部上限 50
  --limit <n>            最多选中的迁移候选数，0 表示全部
  --apply                允许写入；未提供时永远只读
  --backup <dir>         正式写入必填，且备份环境必须与 --env 一致
  --confirm-env <envId>  第一道写入确认
  --confirm-write <text> 第二道写入确认`);
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const now = dependencies.now || new Date();
  const options = validateMigrationOptions(parseMigrationArgs(argv, now));
  if (options.help) {
    printHelp();
    return null;
  }

  verifyApplyBackup(options);
  const database = dependencies.database || await createCloudbaseDatabase(options.envId);
  const result = await runInquiryContactTypeMigration(database, options);
  const report = buildAuditReport(result, options, now);
  writePrivateReport(options.reportPath, report);

  console.log(`需求联系方式迁移${result.mode === "apply" ? "执行" : "预检"}完成`);
  console.log(`- 环境：${options.envId}`);
  console.log(`- 扫描：${result.summary.scanned} 条`);
  console.log(`- 候选：${result.summary.candidates} 条`);
  console.log(`- 选中：${result.summary.selected} 条`);
  console.log(`- 报告：${options.reportPath}`);

  const failedCount = result.summary.outcomes.failed || 0;
  if (failedCount > 0) {
    throw new Error(`${failedCount} 条迁移失败，请查看报告后重试`);
  }
  return report;
}

const executedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === executedPath) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

export {
  APPLY_CONFIRMATION,
  REPORT_SCHEMA_VERSION,
  buildAuditReport,
  main,
  parseMigrationArgs,
  validateMigrationOptions,
  verifyApplyBackup,
  writePrivateReport,
};

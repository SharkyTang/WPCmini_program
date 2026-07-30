import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DEFAULT_CASE_COLLECTION = "wine_packaging";
const DEFAULT_META_COLLECTION = "catalog_meta";
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 100;
const DEFAULT_SORT_ORDER = 9999;
const MAX_CASE_SEQUENCE = 999999;
const HOME_SECTIONS = ["banner", "popular", "latest"];
const HOME_DISPLAY_LIMITS = {
  banner: 5,
  popular: 4,
  latest: 6,
};

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeValues(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  if (Array.isArray(value.values)) return value.values.filter(Boolean);
  if (typeof value === "string") return value ? [value] : [];
  return [];
}

function toSortOrder(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : DEFAULT_SORT_ORDER;
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sameObject(left, right) {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => {
    return key === rightKeys[index] && left[key] === right[key];
  });
}

function stableCaseKey(record = {}) {
  return String(record.caseId || record._id || record.id || "");
}

function compareCases(left, right, direction) {
  const sortDifference = toSortOrder(left.sortOrder) - toSortOrder(right.sortOrder);
  if (sortDifference !== 0) {
    return direction === "desc" ? -sortDifference : sortDifference;
  }
  return stableCaseKey(left).localeCompare(stableCaseKey(right));
}

function getDocumentId(record = {}) {
  return trimText(record._id || record.id);
}

function hasSection(record, section) {
  return normalizeValues(record.homeSections).includes(section);
}

function isDeleted(record = {}) {
  return Boolean(record.deletedAt);
}

function isVisible(record = {}) {
  return record.isVisible === true;
}

function buildSectionRanks(records, section) {
  const direction = section === "latest" ? "desc" : "asc";
  const eligible = records
    .filter(
      (record) => !isDeleted(record) && isVisible(record) && hasSection(record, section)
    )
    .sort((left, right) => compareCases(left, right, direction));
  const limit = HOME_DISPLAY_LIMITS[section];
  const orderCounts = eligible.reduce((counts, record) => {
    const order = isPlainObject(record.homeSectionOrder)
      ? record.homeSectionOrder[section]
      : undefined;
    if (isPositiveInteger(order) && order <= limit) {
      counts.set(order, (counts.get(order) || 0) + 1);
    }
    return counts;
  }, new Map());
  const ranks = new Map();
  const usedOrders = new Set();
  const hasDuplicateOrder = Array.from(orderCounts.values()).some((count) => count > 1);

  if (!hasDuplicateOrder) {
    for (const record of eligible) {
      const order = isPlainObject(record.homeSectionOrder)
        ? record.homeSectionOrder[section]
        : undefined;
      if (
        isPositiveInteger(order) &&
        order <= limit &&
        orderCounts.get(order) === 1
      ) {
        ranks.set(getDocumentId(record), order);
        usedOrders.add(order);
      }
    }
  }

  const availableOrders = Array.from(
    { length: limit },
    (_, index) => index + 1
  ).filter((order) => !usedOrders.has(order));
  for (const record of eligible) {
    const documentId = getDocumentId(record);
    if (ranks.has(documentId)) continue;
    const nextOrder = availableOrders.shift();
    if (!nextOrder) break;
    ranks.set(documentId, nextOrder);
  }
  return ranks;
}

function buildHomeSectionOrder(record, ranksBySection) {
  const existing = isPlainObject(record.homeSectionOrder)
    ? { ...record.homeSectionOrder }
    : {};

  for (const section of HOME_SECTIONS) {
    const rank = ranksBySection[section].get(getDocumentId(record));
    if (isPositiveInteger(rank)) existing[section] = rank;
    else delete existing[section];
  }

  return existing;
}

export function getSequentialCaseNumber(caseId) {
  const match = /^case_(\d{1,6})$/.exec(trimText(caseId));
  if (!match) return 0;
  const numberValue = Number(match[1]);
  return isPositiveInteger(numberValue) && numberValue <= MAX_CASE_SEQUENCE
    ? numberValue
    : 0;
}

export function getNextCaseNumber(records = []) {
  const maxNumber = records.reduce((max, record) => {
    return Math.max(max, getSequentialCaseNumber(record && record.caseId));
  }, 0);
  return maxNumber + 1;
}

export function buildMigrationPlan(records = [], currentMeta = null) {
  const ranksBySection = Object.fromEntries(
    HOME_SECTIONS.map((section) => [section, buildSectionRanks(records, section)])
  );

  const patches = records.map((record) => {
    const documentId = getDocumentId(record);
    if (!documentId) {
      throw new Error("wine_packaging 中存在缺少 _id 的记录，已停止迁移");
    }

    const changes = {};
    if (!isPositiveInteger(record.version)) changes.version = 1;

    const nextOrder = buildHomeSectionOrder(record, ranksBySection);
    const currentOrder = isPlainObject(record.homeSectionOrder)
      ? record.homeSectionOrder
      : null;
    if (!currentOrder || !sameObject(currentOrder, nextOrder)) {
      changes.homeSectionOrder = nextOrder;
    }

    return { documentId, caseId: trimText(record.caseId), changes };
  }).filter((item) => Object.keys(item.changes).length > 0);

  const calculatedNextCaseNumber = getNextCaseNumber(records);
  const existingNextCaseNumber = isPositiveInteger(currentMeta && currentMeta.nextCaseNumber)
    ? currentMeta.nextCaseNumber
    : 0;
  const nextCaseNumber = Math.max(calculatedNextCaseNumber, existingNextCaseNumber);
  const metaPatch =
    currentMeta && currentMeta.nextCaseNumber === nextCaseNumber
      ? {}
      : { nextCaseNumber };

  return {
    totalCases: records.length,
    patches,
    metaExists: Boolean(currentMeta),
    currentRevision: Number(currentMeta && currentMeta.revision) || 0,
    metaPatch,
    nextCaseNumber,
    sectionCounts: Object.fromEntries(
      HOME_SECTIONS.map((section) => [section, ranksBySection[section].size])
    ),
  };
}

export function parseEnvFile(content) {
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
    if (key) env[key] = value;
    return env;
  }, {});
}

export function loadLocalEnv(envPath = ".env.local") {
  if (!existsSync(envPath)) return false;
  const values = parseEnvFile(readFileSync(envPath, "utf8"));
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

export function parseMigrationArgs(argv = [], env = process.env) {
  const options = {
    envId: trimText(env.CLOUDBASE_ENV_ID || env.TCB_ENV_ID),
    caseCollection: DEFAULT_CASE_COLLECTION,
    metaCollection: DEFAULT_META_COLLECTION,
    pageSize: DEFAULT_PAGE_SIZE,
    dryRun: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    if (argument === "--env") {
      options.envId = trimText(next);
      index += 1;
    } else if (argument === "--collection") {
      options.caseCollection = trimText(next);
      index += 1;
    } else if (argument === "--meta-collection") {
      options.metaCollection = trimText(next);
      index += 1;
    } else if (argument === "--page-size") {
      options.pageSize = Number(next);
      index += 1;
    } else if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }

  if (
    !Number.isInteger(options.pageSize) ||
    options.pageSize < 1 ||
    options.pageSize > MAX_PAGE_SIZE
  ) {
    throw new Error(`--page-size 必须是 1-${MAX_PAGE_SIZE} 的整数`);
  }
  if (!options.caseCollection || !options.metaCollection) {
    throw new Error("集合名称不能为空");
  }
  return options;
}

async function fetchAllCases(database, collectionName, pageSize) {
  const records = [];
  let offset = 0;
  while (true) {
    const response = await database
      .collection(collectionName)
      .orderBy("_id", "asc")
      .skip(offset)
      .limit(pageSize)
      .get();
    const page = Array.isArray(response && response.data) ? response.data : [];
    records.push(...page);
    if (page.length < pageSize) return records;
    offset += pageSize;
  }
}

async function fetchCurrentMeta(database, collectionName) {
  try {
    const response = await database.collection(collectionName).doc("current").get();
    const data = response && response.data;
    if (Array.isArray(data)) return data[0] || null;
    return data || null;
  } catch (error) {
    const code = String((error && (error.code || error.errCode)) || "");
    const message = String((error && error.message) || "");
    if (
      code.includes("NOT_FOUND") ||
      code.includes("DOCUMENT_NOT_EXIST") ||
      /document (does not exist|not found)|文档不存在/i.test(message)
    ) {
      return null;
    }
    throw error;
  }
}

export async function applyMigrationPlan(database, plan, options = {}) {
  if (options.dryRun) {
    return { appliedCases: 0, metaUpdated: false };
  }

  const caseCollection = options.caseCollection || DEFAULT_CASE_COLLECTION;
  const metaCollection = options.metaCollection || DEFAULT_META_COLLECTION;
  let appliedCases = 0;

  for (const patch of plan.patches) {
    await database.collection(caseCollection).doc(patch.documentId).update(patch.changes);
    appliedCases += 1;
  }

  const hasChanges = appliedCases > 0 || Object.keys(plan.metaPatch).length > 0;
  if (!hasChanges) return { appliedCases, metaUpdated: false };

  const metaDocument = database.collection(metaCollection).doc("current");
  const updatedAt =
    typeof database.serverDate === "function"
      ? database.serverDate()
      : new Date().toISOString();
  if (plan.metaExists) {
    const command = database.command;
    const revision =
      command && typeof command.inc === "function"
        ? command.inc(1)
        : plan.currentRevision + 1;
    await metaDocument.update({
      ...plan.metaPatch,
      revision,
      updatedAt,
    });
  } else {
    await metaDocument.set({
      revision: 1,
      ...plan.metaPatch,
      updatedAt,
    });
  }

  return { appliedCases, metaUpdated: true };
}

export async function migrateDesktopAdminData(database, options = {}) {
  const caseCollection = options.caseCollection || DEFAULT_CASE_COLLECTION;
  const metaCollection = options.metaCollection || DEFAULT_META_COLLECTION;
  const pageSize = options.pageSize || DEFAULT_PAGE_SIZE;
  const records = await fetchAllCases(database, caseCollection, pageSize);
  const currentMeta = await fetchCurrentMeta(database, metaCollection);
  const plan = buildMigrationPlan(records, currentMeta);
  const result = await applyMigrationPlan(database, plan, {
    dryRun: options.dryRun === true,
    caseCollection,
    metaCollection,
  });
  return { ...plan, ...result, dryRun: options.dryRun === true };
}

function printHelp() {
  console.log(`用法:
  npm run migrate:admin:dry -- --env <staging-env-id>
  npm run migrate:admin -- --env <env-id>

参数:
  --env <env-id>            CloudBase 环境 ID；也可设置 CLOUDBASE_ENV_ID
  --collection <name>       案例集合，默认 ${DEFAULT_CASE_COLLECTION}
  --meta-collection <name>  元数据集合，默认 ${DEFAULT_META_COLLECTION}
  --page-size <1-100>       读取分页大小，默认 ${DEFAULT_PAGE_SIZE}
  --dry-run                 只读取并输出计划，不写数据库
  --help                    显示帮助
`);
}

function printSummary(result) {
  console.log(result.dryRun ? "桌面后台迁移预览（未写入）" : "桌面后台迁移完成");
  console.log(`- 案例总数：${result.totalCases}`);
  console.log(`- 待更新案例：${result.patches.length}`);
  console.log(`- 首页顺序：轮播 ${result.sectionCounts.banner}，热门 ${result.sectionCounts.popular}，最新 ${result.sectionCounts.latest}`);
  console.log(`- nextCaseNumber：${result.nextCaseNumber}`);
  if (result.dryRun && result.patches.length) {
    console.log("- 前 5 条变更：");
    console.log(JSON.stringify(result.patches.slice(0, 5), null, 2));
  }
}

async function createDatabase(envId) {
  const secretId = process.env.TENCENTCLOUD_SECRET_ID;
  const secretKey = process.env.TENCENTCLOUD_SECRET_KEY;
  if (!secretId || !secretKey) {
    throw new Error(
      "缺少服务端凭证：请在 .env.local 中设置 TENCENTCLOUD_SECRET_ID 和 TENCENTCLOUD_SECRET_KEY"
    );
  }
  const { default: cloudbase } = await import("@cloudbase/node-sdk");
  const app = cloudbase.init({ env: envId, secretId, secretKey });
  return app.database();
}

async function main() {
  loadLocalEnv();
  const options = parseMigrationArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (!options.envId) {
    throw new Error("缺少 CloudBase 环境 ID：请使用 --env 或设置 CLOUDBASE_ENV_ID");
  }
  const database = await createDatabase(options.envId);
  const result = await migrateDesktopAdminData(database, options);
  printSummary(result);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

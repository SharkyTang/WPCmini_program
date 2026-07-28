import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const modulePath = resolve(
  __dirname,
  "../miniprogram/cloudfunctions/userData/index.js"
);
const logic = require(resolve(
  __dirname,
  "../miniprogram/cloudfunctions/userData/userDataLogic.js"
));

function createQuery(collectionName, calls, records = []) {
  return {
    where(condition) {
      calls.push({ collectionName, type: "where", condition });
      return this;
    },
    orderBy(field, direction) {
      calls.push({ collectionName, type: "orderBy", field, direction });
      return this;
    },
    limit(value) {
      calls.push({ collectionName, type: "limit", value });
      return this;
    },
    async get() {
      return { data: records };
    },
  };
}

function loadUserDataFunction(options = {}) {
  const calls = [];
  const added = [];
  const recordsByCollection = {
    ...(options.recordsByCollection || {}),
  };
  if (options.records) {
    recordsByCollection.user_profiles = options.records;
  }
  const mockCloud = {
    DYNAMIC_CURRENT_ENV: "dynamic-env",
    init() {},
    getWXContext() {
      return {
        OPENID: options.openid || "openid_1",
        APPID: options.appid || "wx351f937287eb5886",
      };
    },
    async getTempFileURL({ fileList }) {
      return {
        fileList: fileList.map((fileID) => ({
          fileID,
          tempFileURL: `https://temp/${encodeURIComponent(fileID)}`,
        })),
      };
    },
    openapi: {
      subscribeMessage: {
        async getTemplateList() {
          if (options.templateListError) throw options.templateListError;
          return {
            data: options.templateList || [],
          };
        },
      },
    },
    database() {
      return {
        serverDate() {
          return "server-date";
        },
        collection(collectionName) {
          const records = recordsByCollection[collectionName] || [];
          recordsByCollection[collectionName] = records;
          return {
            ...createQuery(collectionName, calls, records),
            async add(payload) {
              added.push({ collectionName, payload });
              records.push({
                _id: `${collectionName}_new`,
                ...(payload.data || {}),
              });
              return { _id: `${collectionName}_new` };
            },
            doc(id) {
              return {
                async update(payload) {
                  calls.push({ collectionName, type: "update", id, payload });
                  const record = records.find((item) => item._id === id);
                  if (record) Object.assign(record, payload.data || {});
                  return {};
                },
              };
            },
          };
        },
      };
    },
  };
  const sandbox = {
    module: { exports: {} },
    exports: {},
    console,
    process: {
      env: {
        VERSION_UPDATE_TEMPLATE_ID: "version_template_id_1234567890",
        PRODUCT_NEW_TEMPLATE_ID: "product_template_id_1234567890",
        ...(options.env || {}),
      },
    },
    require(moduleName) {
      if (moduleName === "wx-server-sdk") return mockCloud;
      if (moduleName === "./userDataLogic") return logic;
      throw new Error(`Unexpected require: ${moduleName}`);
    },
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(readFileSync(modulePath, "utf8"), sandbox, {
    filename: modulePath,
  });
  return {
    main: sandbox.module.exports.main,
    calls,
    added,
  };
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

await test("fetchSubscriptionStatus uses server openid and returns configured templates", async () => {
  const { main, calls } = loadUserDataFunction({
    openid: "server_openid",
    recordsByCollection: {
      notification_subscriptions: [{
        _id: "subscription_1",
        openid: "server_openid",
        type: "product_new",
        templateId: "product_template_id_1234567890",
        status: "granted",
      }],
    },
  });

  const result = await main({
    action: "fetchSubscriptionStatus",
    openid: "spoofed",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), {
    collectionName: "notification_subscriptions",
    type: "where",
    condition: {
      openid: "server_openid",
    },
  });
  assert.equal(result.subscriptions.product_new.status, "granted");
  assert.equal(result.templateIds.version_update, "version_template_id_1234567890");
  assert.equal(result.templateConfigs.version_update.valid, true);
});

await test("invalid template numbers are diagnosed and stale grants are ignored", async () => {
  const { main } = loadUserDataFunction({
    env: {
      VERSION_UPDATE_TEMPLATE_ID: "10103",
      PRODUCT_NEW_TEMPLATE_ID: "product_template_id_new_1234567890",
    },
    recordsByCollection: {
      notification_subscriptions: [{
        _id: "subscription_old",
        openid: "openid_1",
        type: "product_new",
        templateId: "product_template_id_old_1234567890",
        status: "granted",
      }],
    },
  });
  const result = await main({ action: "fetchSubscriptionStatus" });
  assert.equal(result.templateConfigs.version_update.valid, false);
  assert.equal(result.templateConfigs.version_update.envKey, "VERSION_UPDATE_TEMPLATE_ID");
  assert.equal(result.subscriptions.product_new.status, "idle");
  assert.equal(
    result.subscriptions.product_new.templateId,
    "product_template_id_new_1234567890"
  );
});

await test("verifySubscriptionTemplates checks the running AppID template list", async () => {
  const { main } = loadUserDataFunction({
    appid: "wx351f937287eb5886",
    templateList: [{
      priTmplId: "version_template_id_1234567890",
      title: "升级成功通知",
      type: 2,
    }],
  });

  const result = await main({ action: "verifySubscriptionTemplates" });

  assert.equal(result.ok, true);
  assert.equal(result.appid, "wx351f937287eb5886");
  assert.equal(result.verificationAvailable, true);
  assert.equal(result.templates.version_update.existsInCurrentApp, true);
  assert.equal(result.templates.version_update.title, "升级成功通知");
  assert.equal(result.templates.product_new.existsInCurrentApp, false);
  assert.equal(
    result.templates.product_new.code,
    "TEMPLATE_NOT_IN_CURRENT_APP"
  );
});

await test("saveSubscriptionGrant stores server openid and normalized status", async () => {
  const { main, added } = loadUserDataFunction({
    openid: "server_openid",
  });

  const result = await main({
    action: "saveSubscriptionGrant",
    type: "product_new",
    templateId: "product_template_id_1234567890",
    status: "accept",
    openid: "spoofed",
  });

  assert.equal(result.ok, true);
  assert.equal(added[0].collectionName, "notification_subscriptions");
  assert.equal(added[0].payload.data.openid, "server_openid");
  assert.equal(added[0].payload.data.status, "granted");
});

await test("submitInquiry stores server openid and sanitized fields", async () => {
  const { main, added } = loadUserDataFunction({
    openid: "server_openid",
  });

  const result = await main({
    action: "submitInquiry",
    inquiry: {
      packageTypes: ["礼盒"],
      content: "想做一套礼盒包装",
      contact: "wx-test",
      openid: "spoofed",
      adminNote: "bad",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(added[0].collectionName, "inquiries");
  assert.equal(added[0].payload.data.openid, "server_openid");
  assert.equal(added[0].payload.data.status, "new");
  assert.equal(Object.prototype.hasOwnProperty.call(added[0].payload.data, "adminNote"), false);
});

await test("getProfile only queries the server openid", async () => {
  const { main, calls } = loadUserDataFunction({
    openid: "server_openid",
    records: [{ _id: "profile_1", openid: "server_openid", nickname: "酒友", avatarFileId: "cloud://avatar" }],
  });

  const result = await main({ action: "getProfile", openid: "spoofed" });

  assert.deepEqual(JSON.parse(JSON.stringify(result.profile)), {
    nickname: "酒友",
    avatarFileId: "cloud://avatar",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), {
    collectionName: "user_profiles",
    type: "where",
    condition: { openid: "server_openid" },
  });
});

await test("getSessionSummary returns profile, avatar and independent admin roles", async () => {
  const { main, calls } = loadUserDataFunction({
    openid: "case_admin",
    env: {
      ADMIN_OPENIDS: "legacy_admin",
      INQUIRY_ADMIN_OPENIDS: "inquiry_admin",
      CASE_ADMIN_OPENIDS: "case_admin",
      NOTIFICATION_ADMIN_OPENIDS: "notification_admin",
    },
    records: [{
      _id: "profile_1",
      openid: "case_admin",
      nickname: "酒友",
      avatarFileId: "cloud://env/avatar.jpg",
    }],
  });

  const result = await main({
    action: "getSessionSummary",
    openid: "spoofed",
  });

  assert.equal(result.ok, true);
  assert.equal(result.openid, "case_admin");
  assert.equal(result.profile.nickname, "酒友");
  assert.equal(result.profile.avatarUrl, "https://temp/cloud%3A%2F%2Fenv%2Favatar.jpg");
  assert.deepEqual(JSON.parse(JSON.stringify(result.roles)), {
    inquiryAdmin: false,
    caseAdmin: true,
    notificationAdmin: false,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].condition)), {
    openid: "case_admin",
  });
});

await test("session role configuration falls back to ADMIN_OPENIDS", async () => {
  const { main } = loadUserDataFunction({
    openid: "legacy_admin",
    env: {
      ADMIN_OPENIDS: "legacy_admin",
    },
  });
  const result = await main({ action: "getSessionSummary" });
  assert.deepEqual(JSON.parse(JSON.stringify(result.roles)), {
    inquiryAdmin: true,
    caseAdmin: true,
    notificationAdmin: true,
  });
});

await test("saveProfile creates a profile with server openid only", async () => {
  const { main, added } = loadUserDataFunction({ openid: "server_openid" });

  const result = await main({
    action: "saveProfile",
    profile: {
      nickname: "酒友",
      avatarFileId: "cloud://avatar",
      openid: "spoofed",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(added[0].collectionName, "user_profiles");
  assert.equal(added[0].payload.data.openid, "server_openid");
  assert.deepEqual(JSON.parse(JSON.stringify(result.profile)), {
    nickname: "酒友",
    avatarFileId: "cloud://avatar",
  });
});

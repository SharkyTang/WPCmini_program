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
  const mockCloud = {
    DYNAMIC_CURRENT_ENV: "dynamic-env",
    init() {},
    getWXContext() {
      return {
        OPENID: options.openid || "openid_1",
      };
    },
    database() {
      return {
        serverDate() {
          return "server-date";
        },
        collection(collectionName) {
          return {
            ...createQuery(collectionName, calls, options.records || []),
            async add(payload) {
              added.push({ collectionName, payload });
              return { _id: `${collectionName}_new` };
            },
            doc(id) {
              return {
                async update(payload) {
                  calls.push({ collectionName, type: "update", id, payload });
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

await test("fetchCustomerNotifications uses server openid as targetOpenId", async () => {
  const { main, calls } = loadUserDataFunction({
    openid: "server_openid",
  });

  const result = await main({
    action: "fetchCustomerNotifications",
    openid: "spoofed",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), {
    collectionName: "customer_notifications",
    type: "where",
    condition: {
      targetOpenId: "server_openid",
      isVisible: true,
    },
  });
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

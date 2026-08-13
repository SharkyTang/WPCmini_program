import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const functionPath = resolve(
  __dirname,
  "../miniprogram/cloudfunctions/inquiryAdmin/index.js"
);

function loadInquiryAdmin(options = {}) {
  const cloud = {
    DYNAMIC_CURRENT_ENV: "dynamic-env",
    init() {},
    getWXContext() {
      return { OPENID: options.openid || "visitor" };
    },
    database() {
      return {
        collection() {
          throw new Error("checkAccess must not query the database");
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
        ADMIN_OPENIDS: options.adminOpenids || "",
        INQUIRY_ADMIN_OPENIDS: options.inquiryAdminOpenids || "",
      },
    },
    require(moduleName) {
      if (moduleName === "wx-server-sdk") return cloud;
      throw new Error(`Unexpected require: ${moduleName}`);
    },
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(readFileSync(functionPath, "utf8"), sandbox, {
    filename: functionPath,
  });
  return sandbox.module.exports.main;
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

await test("inquiry-specific admins override the general admin list", async () => {
  const roleAdmin = loadInquiryAdmin({
    openid: "inquiry_admin",
    inquiryAdminOpenids: " inquiry_admin ",
    adminOpenids: "general_admin",
  });
  const generalAdmin = loadInquiryAdmin({
    openid: "general_admin",
    inquiryAdminOpenids: "inquiry_admin",
    adminOpenids: "general_admin",
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(await roleAdmin({ action: "checkAccess" }))),
    { ok: true, isAdmin: true }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(await generalAdmin({ action: "checkAccess" }))),
    { ok: true, isAdmin: false }
  );
});

await test("blank inquiry role configuration falls back to ADMIN_OPENIDS", async () => {
  const main = loadInquiryAdmin({
    openid: "general_admin",
    inquiryAdminOpenids: "   ",
    adminOpenids: " general_admin ",
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(await main({ action: "checkAccess" }))),
    { ok: true, isAdmin: true }
  );
});

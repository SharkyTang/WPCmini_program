import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
function loadCommonJsModule(modulePath, dependencies = {}) {
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require(moduleName) {
      if (Object.prototype.hasOwnProperty.call(dependencies, moduleName)) {
        return dependencies[moduleName];
      }
      throw new Error(`Unexpected require: ${moduleName}`);
    },
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(readFileSync(modulePath, "utf8"), sandbox, {
    filename: modulePath,
  });
  return sandbox.module.exports;
}

const caseData = loadCommonJsModule(resolve(
  __dirname,
  "../miniprogram/miniprogram/utils/caseData.js"
));
const client = loadCommonJsModule(resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/inquiry/utils/inquiryData.js"
), { "../../../utils/caseData": caseData });
const server = loadCommonJsModule(resolve(
  __dirname,
  "../miniprogram/cloudfunctions/userData/userDataLogic.js"
), { crypto });
const admin = loadCommonJsModule(resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/inquiry-admin/utils/inquiryAdminData.js"
), { "../../../utils/caseData": caseData });

const contractCases = [
  { contactType: "wechat", contact: "qianrun66888", label: "微信号" },
  { contactType: "phone", contact: "13800138000", label: "手机号" },
  { contactType: "email", contact: "customer@example.com", label: "邮箱" },
];

for (const contractCase of contractCases) {
  const clientDraft = client.normalizeInquiryDraft({
    source: "profile",
    wineType: "白酒",
    packageTypes: ["礼盒"],
    content: "需要一千套定制包装",
    contactType: contractCase.contactType,
    contact: contractCase.contact,
  });
  const clientValidation = client.validateInquiryDraft(clientDraft);
  assert.equal(clientValidation.valid, true, `${contractCase.contactType} client`);
  assert.equal(clientValidation.data.inquirySchemaVersion, 2);

  const serverValidation = server.validateInquiryDraft(clientValidation.data);
  assert.equal(serverValidation.valid, true, `${contractCase.contactType} server`);
  const stored = server.buildInquiryRecord(serverValidation.data, {
    openid: "customer_openid_from_context",
    source: "profile",
  });
  assert.equal(stored.contactType, contractCase.contactType);
  assert.equal(stored.contactTypeSource, "customer_selected");
  assert.equal(stored.openid, "customer_openid_from_context");

  const displayed = admin.normalizeInquiryAdminItem({
    _id: `inquiry_${contractCase.contactType}`,
    ...stored,
  });
  assert.equal(displayed.contactType, contractCase.contactType);
  assert.equal(displayed.contactTypeLabel, contractCase.label);
  assert.equal(displayed.contactTypeNeedsCorrection, false);
}

console.log("ok - inquiry contact type client/server/admin contract");

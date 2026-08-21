import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadCommonJs(filePath, dependencies = {}, globals = {}) {
  const sandbox = {
    module: { exports: {} },
    exports: {},
    console,
    ...globals,
    require(name) {
      if (Object.prototype.hasOwnProperty.call(dependencies, name)) return dependencies[name];
      throw new Error(`Unexpected require: ${name}`);
    },
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(readFileSync(filePath, "utf8"), sandbox, { filename: filePath });
  return sandbox.module.exports;
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

const dataPath = resolve(
  __dirname,
  "../miniprogram/miniprogram/pages/my-inquiries/utils/myInquiryData.js"
);
const data = loadCommonJs(dataPath);

await test("my inquiry data normalizes customer-safe list and unread labels", () => {
  const item = data.normalizeMyInquiry({
    _id: "inquiry_1",
    status: "contacted",
    packageTypes: ["礼盒", "手提袋"],
    content: "想做一套企业纪念礼盒",
    contactType: "wechat",
    customerUnreadCount: 120,
    createdAt: "2026-08-21T01:02:00.000Z",
  });
  assert.equal(item.id, "inquiry_1");
  assert.equal(item.statusLabel, "已回复");
  assert.equal(item.packageSummary, "礼盒 / 手提袋");
  assert.equal(item.contactTypeLabel, "微信号");
  assert.equal(item.unreadLabel, "99+");
});

await test("my inquiry service calls only private userData actions", async () => {
  const calls = [];
  const servicePath = resolve(
    __dirname,
    "../miniprogram/miniprogram/pages/my-inquiries/utils/myInquiryService.js"
  );
  const service = loadCommonJs(servicePath, {
    "../../../utils/userDataService": {
      async callUserData(action, payload) {
        calls.push({ action, payload });
        if (action === "listMyInquiries") {
          return {
            items: [{ id: "inquiry_1", status: "new" }],
            nextCursor: "123",
            hasMore: true,
          };
        }
        if (action === "getMyInquiryDetail") {
          return {
            item: { id: "inquiry_1", status: "contacted" },
            messages: [{ id: "message_1", content: "已添加您的微信好友" }],
            nextMessageCursor: "message_cursor_2",
            hasMoreMessages: true,
            seenThroughToken: "read_token_1",
            seenThroughReplyCount: 1,
          };
        }
        return {};
      },
    },
    "../../../utils/inquiryFollowupService": {
      subscribeToInquiryReply() {},
    },
    "./myInquiryData": data,
  });

  const list = await service.fetchMyInquiryList({ cursor: "", pageSize: 20 });
  const detail = await service.fetchMyInquiryDetail("inquiry_1", {
    messageCursor: "message_cursor_1",
    messagePageSize: 25,
  });
  await service.markMyInquiryRead("inquiry_1", "read_token_1");
  assert.equal(list.items[0].id, "inquiry_1");
  assert.equal(detail.messages[0].content, "已添加您的微信好友");
  assert.equal(detail.nextMessageCursor, "message_cursor_2");
  assert.equal(detail.hasMoreMessages, true);
  assert.equal(calls[1].payload.messageCursor, "message_cursor_1");
  assert.equal(calls[1].payload.messagePageSize, 25);
  assert.equal(calls[2].payload.seenThroughToken, "read_token_1");
  assert.deepEqual(calls.map((call) => call.action), [
    "listMyInquiries",
    "getMyInquiryDetail",
    "markInquiryMessagesRead",
  ]);
});

await test("detail page loads every message page before sending the final read token", async () => {
  const fetchCursors = [];
  const readReceipts = [];
  let pageDefinition;
  const detailPath = resolve(
    __dirname,
    "../miniprogram/miniprogram/pages/my-inquiries/detail.js"
  );
  loadCommonJs(detailPath, {
    "./utils/myInquiryService": {
      async fetchMyInquiryDetail(id, options) {
        fetchCursors.push(options.messageCursor);
        if (!options.messageCursor) {
          return {
            item: { id, customerUnreadCount: 2 },
            messages: [{ id: "message_1", content: "first" }],
            nextMessageCursor: "cursor_2",
            hasMoreMessages: true,
            seenThroughToken: "",
            replySubscription: { enabled: false, templateId: "" },
          };
        }
        return {
          item: { id, customerUnreadCount: 2 },
          messages: [{ id: "message_2", content: "second" }],
          nextMessageCursor: "",
          hasMoreMessages: false,
          seenThroughToken: "seen_through_2",
          replySubscription: { enabled: false, templateId: "" },
        };
      },
      async markMyInquiryRead(id, token) {
        readReceipts.push({ id, token });
        return { unreadCount: 1 };
      },
      async subscribeToInquiryReply() {},
    },
  }, {
    Page(definition) {
      pageDefinition = definition;
    },
    wx: {},
  });
  const page = {
    ...pageDefinition,
    data: JSON.parse(JSON.stringify(pageDefinition.data)),
    setData(patch) {
      Object.entries(patch).forEach(([key, value]) => {
        const parts = key.split(".");
        let target = this.data;
        while (parts.length > 1) {
          const part = parts.shift();
          if (!target[part]) target[part] = {};
          target = target[part];
        }
        target[parts[0]] = value;
      });
    },
  };
  page.onLoad({ id: "inquiry_1" });
  await page.loadDetail();
  assert.deepEqual(fetchCursors, ["", "cursor_2"]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(page.data.messages.map((message) => message.id))),
    ["message_1", "message_2"]
  );
  assert.deepEqual(readReceipts, [{ id: "inquiry_1", token: "seen_through_2" }]);
  assert.equal(page.data.item.customerUnreadCount, 1);
});

await test("detail template renders each reply instead of repeating inquiry content", () => {
  const template = readFileSync(resolve(
    __dirname,
    "../miniprogram/miniprogram/pages/my-inquiries/detail.wxml"
  ), "utf8");
  assert.match(template, /wx:for-item="message"/);
  assert.match(template, /\{\{message\.createdAtText\}\}/);
  assert.match(template, /\{\{message\.content\}\}/);
  assert.doesNotMatch(template, /顾问回复 · \{\{item\.createdAtText\}\}/);
});

await test("follow-up indexes cover stable customer inquiry and exact reply cursors", () => {
  const indexConfig = JSON.parse(readFileSync(resolve(
    __dirname,
    "../miniprogram/cloudbase/inquiry-followup.indexes.json"
  ), "utf8"));
  const inquiryIndex = indexConfig.inquiries.find(
    (item) => item.name === "openid_createdAt_id"
  );
  const unreadIndex = indexConfig.inquiries.find((item) => item.name === "openid_id");
  const messageIndex = indexConfig.inquiry_messages.find(
    (item) => item.name === "inquiry_customer_direction_createdAt_id"
  );
  assert.deepEqual(inquiryIndex.fields.map((field) => field.field), [
    "openid",
    "createdAt",
    "_id",
  ]);
  assert.deepEqual(unreadIndex.fields.map((field) => field.field), ["openid", "_id"]);
  assert.deepEqual(messageIndex.fields.map((field) => field.field), [
    "inquiryId",
    "customerVisible",
    "direction",
    "createdAt",
    "_id",
  ]);
});

await test("reply subscription stores the exact user gesture result", async () => {
  const calls = [];
  const followupPath = resolve(
    __dirname,
    "../miniprogram/miniprogram/utils/inquiryFollowupService.js"
  );
  const templateId = "reply_template_id_123456789012345";
  const followup = loadCommonJs(followupPath, {
    "./userDataService": {
      async callUserData(action, payload) {
        calls.push({ action, payload });
        return { status: "granted" };
      },
    },
  }, {
    wx: {
      requestSubscribeMessage(options) {
        options.success({ [templateId]: "accept" });
      },
    },
  });
  const result = await followup.subscribeToInquiryReply("inquiry_1", templateId);
  assert.equal(result.accepted, true);
  assert.equal(calls[0].action, "saveInquiryReplySubscription");
  assert.equal(calls[0].payload.status, "accept");
  assert.equal(calls[0].payload.id, "inquiry_1");
});

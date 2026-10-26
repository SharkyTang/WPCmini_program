import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const miniRoot = resolve(__dirname, "../miniprogram/miniprogram");

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function setPageData(nextData) {
  Object.entries(nextData).forEach(([key, value]) => {
    if (!key.includes(".")) {
      this.data[key] = value;
      return;
    }
    const parts = key.split(".");
    let target = this.data;
    parts.slice(0, -1).forEach((part) => {
      target[part] = target[part] || {};
      target = target[part];
    });
    target[parts.at(-1)] = value;
  });
}

function loadCommonJsModule(modulePath, options = {}) {
  const sandbox = {
    module: { exports: {} },
    exports: {},
    console,
    Date: options.Date || Date,
    Math: options.Math || Math,
    wx: options.wx,
    getApp: options.getApp,
    require(moduleName) {
      if (options.dependencies && moduleName in options.dependencies) {
        return options.dependencies[moduleName];
      }
      throw new Error(`Unexpected require: ${moduleName}`);
    },
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(readFileSync(modulePath, "utf8"), sandbox, { filename: modulePath });
  return sandbox.module.exports;
}

const caseData = loadCommonJsModule(resolve(miniRoot, "utils/caseData.js"));
const dataModule = loadCommonJsModule(
  resolve(miniRoot, "pages/inquiry-admin/utils/inquiryAdminData.js"),
  { dependencies: { "../../../utils/caseData": caseData } }
);

function loadService(handler, openid = "admin_a") {
  const calls = [];
  const wx = {
    cloud: {
      async callFunction(request) {
        calls.push(plain(request));
        return { result: await handler(request.data) };
      },
    },
  };
  const service = loadCommonJsModule(
    resolve(miniRoot, "pages/inquiry-admin/utils/inquiryAdminService.js"),
    {
      wx,
      getApp: () => ({ globalData: { openid } }),
      dependencies: { "./inquiryAdminData": dataModule },
    }
  );
  return { service, calls };
}

function loadPage(pageName, serviceOverrides = {}) {
  const modulePath = resolve(miniRoot, `pages/inquiry-admin/${pageName}.js`);
  let page;
  const timers = [];
  const toastCalls = [];
  const service = {
    DEFAULT_PAGE_SIZE: 20,
    checkInquiryAdminAccess: async () => true,
    fetchInquiryList: async () => ({ items: [], page: 1, pageSize: 20, hasMore: false }),
    fetchInquirySummary: async () => dataModule.normalizeInquirySummary(),
    fetchInquiryDetail: async () => ({ item: null, messages: [], timeline: [] }),
    claimInquiry: async () => ({}),
    correctContactType: async () => ({}),
    createClientMutationId: () => "mini-test-1",
    replyInquiry: async () => ({}),
    saveInquiryNote: async (id, note) => note,
    takeOverInquiry: async () => ({}),
    updateInquiryStatus: async (id, status) => status,
    ...serviceOverrides,
  };
  const sandbox = {
    Page(config) {
      page = config;
    },
    console,
    Date,
    encodeURIComponent,
    setTimeout(callback, ms) {
      const timer = { callback, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    },
    require(moduleName) {
      if (moduleName === "./utils/inquiryAdminData") return dataModule;
      if (moduleName === "./utils/inquiryAdminService") return service;
      throw new Error(`Unexpected require: ${moduleName}`);
    },
    wx: {
      navigateTo() {},
      setClipboardData() {},
      showToast(payload) {
        toastCalls.push(payload);
      },
      stopPullDownRefresh() {},
    },
  };
  vm.runInNewContext(readFileSync(modulePath, "utf8"), sandbox, { filename: modulePath });
  page.setData = setPageData;
  page.__timers = timers;
  page.__toastCalls = toastCalls;
  return page;
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

await test("service sends claim filters and normalizes legacy list fields", async () => {
  const { service, calls } = loadService(async (event) => {
    assert.equal(event.action, "listInquiries");
    return {
      ok: true,
      items: [{
        _id: "inq_1",
        status: "new",
        claimedByOpenid: "admin_a",
        lastAdminReplyPreview: "已收到",
      }],
      page: 2,
      pageSize: 10,
      nextCursor: "cursor-2",
      hasMore: true,
    };
  });
  const result = await service.fetchInquiryList({
    status: "new",
    filter: "mine",
    keyword: "  138  ",
    cursor: "cursor-1",
    page: 2,
    pageSize: 10,
  });
  assert.deepEqual(calls[0].data, {
    action: "listInquiries",
    status: "new",
    filter: "mine",
    keyword: "138",
    cursor: "cursor-1",
    page: 2,
    pageSize: 10,
  });
  assert.equal(result.items[0].claimState, "mine");
  assert.equal(result.items[0].lastReply.content, "已收到");
});

await test("service accepts current and legacy detail shapes", async () => {
  let currentShape = true;
  const { service } = loadService(async () => currentShape
    ? {
      ok: true,
      item: { _id: "inq_1", createdAt: "2026-08-21T01:00:00.000Z" },
      messages: [{ _id: "msg_1", content: "已加微信", createdAt: "2026-08-21T01:01:00.000Z" }],
    }
    : { ok: true, _id: "legacy_1", contact: "wx-legacy" });
  const current = await service.fetchInquiryDetail("inq_1");
  assert.equal(current.item.id, "inq_1");
  assert.equal(current.messages[0].id, "msg_1");
  assert.equal(current.timeline.at(-1).type, "reply");

  currentShape = false;
  const legacy = await service.fetchInquiryDetail("legacy_1");
  assert.equal(legacy.item.id, "legacy_1");
  assert.deepEqual(plain(legacy.messages), []);
});

await test("service keeps reply target server-owned and surfaces claim conflicts", async () => {
  let shouldConflict = false;
  const { service, calls } = loadService(async (event) => {
    if (shouldConflict) {
      return {
        ok: false,
        code: "CLAIM_CONFLICT",
        message: "已被其他管理员认领",
        claim: { claimedBy: "admin_b" },
      };
    }
    return {
      ok: true,
      id: event.id,
      status: "contacted",
      claim: { claimedBy: "admin_a", claimedAt: "2026-08-21T01:00:00.000Z" },
      message: { _id: "msg_1", inquiryId: event.id, content: event.content },
      pushStatus: "no_grant",
    };
  });
  const result = await service.replyInquiry("inq_1", "  已收到  ", "mini-fixed-1");
  assert.deepEqual(calls[0].data, {
    action: "replyInquiry",
    id: "inq_1",
    content: "已收到",
    clientMutationId: "mini-fixed-1",
  });
  assert.equal(result.claim.isMine, true);
  assert.equal(result.pushNotice.type, "warning");
  assert.equal("openid" in calls[0].data, false);
  assert.equal("targetOpenid" in calls[0].data, false);

  shouldConflict = true;
  await assert.rejects(
    service.claimInquiry("inq_1"),
    (error) => error.code === "CLAIM_CONFLICT" && error.claim.claimedBy === "admin_b"
  );
});

await test("service calls summary, takeover, and contact correction actions", async () => {
  const { service, calls } = loadService(async (event) => {
    if (event.action === "getInquirySummary") {
      return {
        ok: true,
        total: 5,
        unclaimedCount: 2,
        mineCount: 1,
        followupEnabled: true,
        emailAlertsEnabled: true,
        emailNotifierStatus: "unknown",
      };
    }
    if (event.action === "takeOverInquiry") {
      return { ok: true, id: event.id, claim: { claimedBy: "admin_a" }, takenOver: true };
    }
    return {
      ok: true,
      id: event.id,
      contactType: event.contactType,
      previousContactType: "",
    };
  });
  const summary = await service.fetchInquirySummary();
  assert.equal(summary.emailAlertHasIssue, true);
  const takeover = await service.takeOverInquiry("inq_1", "admin_b");
  assert.equal(takeover.claim.isMine, true);
  assert.equal(calls[1].data.expectedClaimedBy, "admin_b");
  const correction = await service.correctContactType("inq_1", "phone");
  assert.equal(correction.contactType, "phone");
  assert.deepEqual(calls.map((call) => call.data.action), [
    "getInquirySummary",
    "takeOverInquiry",
    "correctContactType",
  ]);
});

await test("list refreshes on show and polls only while visible", async () => {
  const listCalls = [];
  let summaryCalls = 0;
  const page = loadPage("index", {
    fetchInquiryList: async (options) => {
      listCalls.push(plain(options));
      return { items: [], page: 1, pageSize: 20, hasMore: false };
    },
    fetchInquirySummary: async () => {
      summaryCalls += 1;
      return dataModule.normalizeInquirySummary({ total: 2, unclaimedCount: 1, mineCount: 1 });
    },
  });
  page.onShow();
  await page.onLoad();
  assert.equal(listCalls.length, 1);
  assert.equal(summaryCalls, 1);
  assert.equal(page.__timers.length, 1);
  assert.equal(page.__timers[0].ms, 30000);

  await page.__timers[0].callback();
  assert.equal(listCalls.length, 2);
  assert.equal(summaryCalls, 2);
  assert.equal(page.__timers.length, 2);

  page.onHide();
  assert.equal(page.__timers[1].cleared, true);
  const beforeHiddenPoll = listCalls.length;
  await page.__timers[1].callback();
  assert.equal(listCalls.length, beforeHiddenPoll);

  page.setData({ activeClaimFilter: "mine" });
  await page.loadInquiries({ reset: true });
  assert.equal(listCalls.at(-1).filter, "mine");
});

await test("detail confirms takeover before retrying a conflicted reply", async () => {
  let replyCalls = 0;
  let takeoverCalls = 0;
  const page = loadPage("detail", {
    replyInquiry: async (id, content, mutationId) => {
      replyCalls += 1;
      assert.equal(mutationId, "mini-test-1");
      if (replyCalls === 1) {
        const error = new Error("该需求已被其他管理员认领");
        error.code = "CLAIM_CONFLICT";
        error.claim = dataModule.normalizeClaim(
          { claimedBy: "admin_b" },
          { currentOpenid: "admin_a" }
        );
        throw error;
      }
      return {
        status: "contacted",
        claim: {
          isClaimed: true,
          isMine: true,
          state: "mine",
          label: "我在跟进",
          claimedAt: "2026-08-21T01:00:00.000Z",
        },
        message: {
          id: "msg_1",
          content,
          createdAt: "2026-08-21T01:01:00.000Z",
          createdAtText: "2026-08-21 09:01",
        },
        pushNotice: { type: "success", message: "回复已发送" },
      };
    },
    takeOverInquiry: async (id, expectedClaimedBy) => {
      takeoverCalls += 1;
      assert.equal(expectedClaimedBy, "admin_b");
      return {
        claim: {
          isClaimed: true,
          isMine: true,
          state: "mine",
          label: "我在跟进",
          claimedAt: "2026-08-21T01:00:00.000Z",
        },
      };
    },
  });
  const item = dataModule.normalizeInquiryAdminItem({
    _id: "inq_1",
    status: "new",
    createdAt: "2026-08-21T00:59:00.000Z",
  });
  page.setData({ id: "inq_1", item, replyContent: "已经添加您微信好友" });

  assert.equal(await page.sendReply(), false);
  assert.equal(page.data.confirmDialog.action, "takeoverAndReply");
  assert.equal(page.data.item.claim.claimedBy, "admin_b");
  assert.equal(takeoverCalls, 0);

  await page.handleConfirmDialogTap({ detail: { index: 1 } });
  assert.equal(takeoverCalls, 1);
  assert.equal(replyCalls, 2);
  assert.equal(page.data.item.claim.isMine, true);
  assert.equal(page.data.item.status, "contacted");
  assert.equal(page.data.replyContent, "");
  assert.equal(page.data.timeline.at(-1).type, "reply");
});

await test("detail keeps notes separate and confirms inferred contact correction", async () => {
  let correctionCalls = 0;
  let noteCalls = 0;
  const page = loadPage("detail", {
    correctContactType: async (id, contactType) => {
      correctionCalls += 1;
      return { id, contactType, previousContactType: "phone", idempotent: false };
    },
    saveInquiryNote: async (id, note) => {
      noteCalls += 1;
      return note;
    },
  });
  const item = dataModule.normalizeInquiryAdminItem({
    _id: "inq_legacy",
    contact: "13800138000",
    contactType: "phone",
    contactTypeSource: "inferred_legacy",
    adminNote: "内部记录",
  });
  page.setData({ id: "inq_legacy", item, adminNote: "仅管理员可见" });
  assert.equal(page.data.item.contactTypeNeedsConfirmation, true);

  page.onContactTypeChange({ detail: { value: "1" } });
  assert.equal(correctionCalls, 0);
  assert.equal(page.data.confirmDialog.action, "contactType");
  await page.handleConfirmDialogTap({ detail: { index: 1 } });
  assert.equal(correctionCalls, 1);
  assert.equal(page.data.item.contactTypeSource, "admin_corrected");
  assert.equal(page.data.item.contactTypeNeedsConfirmation, false);

  await page.saveAdminNote();
  assert.equal(noteCalls, 1);
  assert.equal(page.data.item.adminNote, "仅管理员可见");
});

await test("templates expose claim, reply, timeline, and internal-note boundaries", () => {
  const listWxml = readFileSync(resolve(miniRoot, "pages/inquiry-admin/index.wxml"), "utf8");
  const detailWxml = readFileSync(resolve(miniRoot, "pages/inquiry-admin/detail.wxml"), "utf8");
  assert.match(listWxml, /activeClaimFilter/);
  assert.match(listWxml, /emailAlertHasIssue/);
  assert.match(detailWxml, /handleClaimTap/);
  assert.match(detailWxml, /sendReply/);
  assert.match(detailWxml, /跟进时间线/);
  assert.match(detailWxml, /仅管理员可见，不会发送给客户/);
  assert.match(detailWxml, /旧数据推断/);
});

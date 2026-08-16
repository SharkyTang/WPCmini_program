import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = resolve(
  __dirname,
  "../miniprogram/miniprogram/utils/nativePageLoading.js"
);
const nativeLoadingModule = { exports: {} };
vm.runInNewContext(readFileSync(modulePath, "utf8"), {
  module: nativeLoadingModule,
  exports: nativeLoadingModule.exports,
  clearTimeout,
  setTimeout,
}, { filename: modulePath });
const {
  createNativePageLoadingController,
} = nativeLoadingModule.exports;

function createFakeClock() {
  let currentTime = 0;
  let nextTimerId = 0;
  const timers = new Map();

  function setTimeoutFn(callback, delay = 0) {
    const id = ++nextTimerId;
    timers.set(id, {
      callback,
      dueAt: currentTime + Math.max(0, Number(delay) || 0),
    });
    return id;
  }

  function clearTimeoutFn(id) {
    timers.delete(id);
  }

  function advance(milliseconds) {
    const targetTime = currentTime + milliseconds;
    while (true) {
      const next = [...timers.entries()]
        .filter(([, timer]) => timer.dueAt <= targetTime)
        .sort((left, right) => {
          if (left[1].dueAt !== right[1].dueAt) {
            return left[1].dueAt - right[1].dueAt;
          }
          return left[0] - right[0];
        })[0];
      if (!next) break;
      const [id, timer] = next;
      timers.delete(id);
      currentTime = timer.dueAt;
      timer.callback();
    }
    currentTime = targetTime;
  }

  return {
    advance,
    clearTimeoutFn,
    now: () => currentTime,
    setTimeoutFn,
  };
}

function createHarness(wxApi = {}) {
  const clock = createFakeClock();
  const events = [];
  const controller = createNativePageLoadingController({
    wxApi: {
      showLoading(payload) {
        events.push(["show", payload]);
        if (wxApi.showLoading) wxApi.showLoading(payload);
      },
      hideLoading() {
        events.push(["hide"]);
        if (wxApi.hideLoading) wxApi.hideLoading();
      },
    },
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  return { clock, controller, events };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

async function test(name, callback) {
  try {
    await callback();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

await test("a quick completion never shows native loading", () => {
  const { clock, controller, events } = createHarness();
  const token = controller.beginPageLoading();

  clock.advance(119);
  assert.equal(controller.finishPageLoading(token), true);
  clock.advance(5000);

  assert.deepEqual(events, []);
});

await test("visible loading uses defaults and honors the 300ms minimum", () => {
  const { clock, controller, events } = createHarness();
  const token = controller.beginPageLoading();

  clock.advance(120);
  assert.deepEqual(plain(events), [
    ["show", { title: "加载中", mask: false }],
  ]);

  clock.advance(50);
  assert.equal(controller.finishPageLoading(token), true);
  clock.advance(249);
  assert.equal(events.length, 1);
  clock.advance(1);
  assert.deepEqual(plain(events), [
    ["show", { title: "加载中", mask: false }],
    ["hide"],
  ]);
});

await test("pending loading is forced closed after 3000ms of visibility", () => {
  const { clock, controller, events } = createHarness();
  const token = controller.beginPageLoading();

  clock.advance(120);
  clock.advance(2999);
  assert.equal(events.length, 1);
  clock.advance(1);

  assert.deepEqual(plain(events), [
    ["show", { title: "加载中", mask: false }],
    ["hide"],
  ]);
  assert.equal(controller.finishPageLoading(token), false);
});

await test("an old owner cannot finish, cancel, or time out a new owner", () => {
  const { clock, controller, events } = createHarness();
  const oldToken = controller.beginPageLoading({ title: "旧页面" });
  clock.advance(120);

  const currentToken = controller.beginPageLoading({ title: "新页面" });
  assert.deepEqual(plain(events), [
    ["show", { title: "旧页面", mask: false }],
    ["hide"],
  ]);
  assert.equal(controller.finishPageLoading(oldToken), false);
  assert.equal(controller.cancelPageLoading(oldToken), false);

  clock.advance(120);
  assert.deepEqual(plain(events.at(-1)), [
    "show",
    { title: "新页面", mask: false },
  ]);
  clock.advance(2880);
  assert.equal(events.at(-1)[0], "show");

  clock.advance(120);
  assert.equal(events.at(-1)[0], "hide");
  assert.equal(controller.finishPageLoading(currentToken), false);
});

await test("repeated completion is idempotent", () => {
  const { clock, controller, events } = createHarness();
  const token = controller.beginPageLoading();
  clock.advance(420);

  assert.equal(controller.finishPageLoading(token), true);
  assert.equal(controller.finishPageLoading(token), false);
  assert.equal(controller.cancelPageLoading(token), false);
  clock.advance(5000);

  assert.deepEqual(events.map((event) => event[0]), ["show", "hide"]);
});

await test("cancellation closes visible loading immediately", () => {
  const { clock, controller, events } = createHarness();
  const token = controller.beginPageLoading();
  clock.advance(130);

  assert.equal(controller.cancelPageLoading(token), true);
  assert.equal(controller.cancelPageLoading(token), false);
  clock.advance(5000);

  assert.deepEqual(events.map((event) => event[0]), ["show", "hide"]);
});

await test("lifecycle cancellation overrides a pending minimum-visible finish once", () => {
  const { clock, controller, events } = createHarness();
  const token = controller.beginPageLoading();
  clock.advance(130);

  assert.equal(controller.finishPageLoading(token), true);
  assert.equal(controller.finishPageLoading(token), true);
  assert.equal(controller.cancelPageLoading(token), true);
  clock.advance(5000);

  assert.deepEqual(events.map((event) => event[0]), ["show", "hide"]);
});

await test("missing native loading APIs degrade without throwing", () => {
  const clock = createFakeClock();
  const controller = createNativePageLoadingController({
    getWxApi: () => null,
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  const token = controller.beginPageLoading();

  assert.doesNotThrow(() => clock.advance(120));
  assert.equal(controller.finishPageLoading(token), true);
  assert.doesNotThrow(() => clock.advance(5000));
});

await test("native API failures are silent and leave no active owner", () => {
  const { clock, controller } = createHarness({
    showLoading() {
      throw new Error("show unavailable");
    },
    hideLoading() {
      throw new Error("hide unavailable");
    },
  });
  const token = controller.beginPageLoading();

  assert.doesNotThrow(() => clock.advance(120));
  assert.doesNotThrow(() => controller.cancelPageLoading(token));
  assert.equal(controller.finishPageLoading(token), false);
  assert.doesNotThrow(() => clock.advance(5000));
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const caseDataPath = resolve(
  __dirname,
  "../miniprogram/miniprogram/utils/caseData.js"
);
const cloudDataPath = resolve(
  __dirname,
  "../miniprogram/miniprogram/utils/cloudData.js"
);

function loadCommonJS(path, extraSandbox = {}) {
  const sandbox = {
    module: { exports: {} },
    exports: {},
    console,
    ...extraSandbox,
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(readFileSync(path, "utf8"), sandbox, { filename: path });
  return sandbox.module.exports;
}

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`ok - ${name}`);
    })
    .catch((error) => {
      console.error(`not ok - ${name}`);
      throw error;
    });
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildQuery(records, onGet = () => {}) {
  const query = {
    offset: 0,
    pageSize: 20,
    where() {
      return this;
    },
    orderBy() {
      return this;
    },
    skip(offset) {
      this.offset = offset;
      return this;
    },
    limit(pageSize) {
      this.pageSize = pageSize;
      return this;
    },
    async get() {
      onGet();
      return {
        data: records.slice(this.offset, this.offset + this.pageSize),
      };
    },
  };
  return query;
}

function mockCloudData(records) {
  const tempUrlBatches = [];
  let queryCount = 0;
  global.wx = {
    cloud: {
      database() {
        return {
          collection() {
            return buildQuery(records, () => {
              queryCount += 1;
            });
          },
        };
      },
      async callFunction({ name, data }) {
        assert.equal(name, "caseAdmin");
        assert.equal(data.action, "getVisibleImageUrls");
        const fileList = data.fileIDs || [];
        tempUrlBatches.push(fileList.slice());
        const signatureVersion = tempUrlBatches.length;
        return {
          result: {
            ok: true,
            urls: fileList.reduce((urls, fileID) => {
              urls[fileID] = `${fileID}?temp=${signatureVersion}`;
              return urls;
            }, {}),
          },
        };
      },
    },
  };

  const caseData = loadCommonJS(caseDataPath);
  const cloudData = loadCommonJS(cloudDataPath, {
    wx: global.wx,
    require(request) {
      if (request === "./caseData") return caseData;
      throw new Error(`Unexpected require: ${request}`);
    },
  });

  return {
    ...cloudData,
    tempUrlBatches,
    getQueryCount() {
      return queryCount;
    },
  };
}

function mockCaseLookupData(records) {
  const docCalls = [];
  const whereCalls = [];
  global.wx = {
    cloud: {
      database() {
        return {
          collection() {
            return {
              doc(id) {
                docCalls.push(id);
                return {
                  async get() {
                    const record = records.find((item) => item._id === id);
                    if (!record) throw new Error("document not found");
                    return { data: record };
                  },
                };
              },
              where(condition) {
                whereCalls.push(condition);
                return {
                  limit() {
                    return this;
                  },
                  async get() {
                    return {
                      data: records.filter((record) =>
                        Object.entries(condition).every(
                          ([key, value]) => record[key] === value
                        )
                      ),
                    };
                  },
                };
              },
            };
          },
        };
      },
    },
  };

  const caseData = loadCommonJS(caseDataPath);
  const cloudData = loadCommonJS(cloudDataPath, {
    wx: global.wx,
    require(request) {
      if (request === "./caseData") return caseData;
      throw new Error(`Unexpected require: ${request}`);
    },
  });

  return {
    ...cloudData,
    docCalls,
    whereCalls,
  };
}

await test("fetches image temp URLs in controlled batches of 20 cloud IDs", async () => {
  const records = Array.from({ length: 55 }, (_, index) => ({
    _id: `case_${index + 1}`,
    caseId: `case_${index + 1}`,
    title: `case_${index + 1}`,
    coverImage: `cloud://image_${index + 1}`,
    isVisible: true,
    sortOrder: index + 1,
  }));

  const { fetchVisibleCases, tempUrlBatches } = mockCloudData(records);
  const cases = await fetchVisibleCases();

  assert.equal(cases.length, 55);
  assert.deepEqual(
    tempUrlBatches.map((batch) => batch.length),
    [20, 20, 15]
  );
  assert.equal(cases[0].coverImageUrl, "cloud://image_1?temp=1");
});

await test("force refresh bypasses visible case and temp URL caches", async () => {
  const records = [
    {
      _id: "case_doc_1",
      caseId: "case_001",
      title: "case_001",
      coverImage: "cloud://image_1",
      isVisible: true,
      sortOrder: 1,
    },
  ];

  const {
    fetchVisibleCases,
    clearCloudDataCache,
    tempUrlBatches,
    getQueryCount,
  } = mockCloudData(records);

  await fetchVisibleCases();
  await fetchVisibleCases();

  assert.equal(getQueryCount(), 1);
  assert.equal(tempUrlBatches.length, 1);

  const refreshed = await fetchVisibleCases({ forceRefresh: true });

  assert.equal(getQueryCount(), 2);
  assert.equal(tempUrlBatches.length, 2);
  assert.equal(refreshed[0].coverImageUrl, "cloud://image_1?temp=2");

  clearCloudDataCache();
  await fetchVisibleCases();

  assert.equal(getQueryCount(), 3);
  assert.equal(tempUrlBatches.length, 3);
});

await test("force refresh bypasses visible banner and temp URL caches", async () => {
  const records = [
    {
      _id: "banner_doc_1",
      caseId: "case_001",
      title: "banner_001",
      image: "cloud://banner_1",
      isVisible: true,
      sortOrder: 1,
    },
  ];

  const {
    fetchVisibleBanners,
    tempUrlBatches,
    getQueryCount,
  } = mockCloudData(records);

  const first = await fetchVisibleBanners([]);
  const cached = await fetchVisibleBanners([]);

  assert.equal(getQueryCount(), 1);
  assert.equal(tempUrlBatches.length, 1);
  assert.equal(first[0].imageUrl, "cloud://banner_1?temp=1");
  assert.equal(cached[0].imageUrl, first[0].imageUrl);

  const refreshed = await fetchVisibleBanners([], { forceRefresh: true });

  assert.equal(getQueryCount(), 2);
  assert.equal(tempUrlBatches.length, 2);
  assert.equal(refreshed[0].imageUrl, "cloud://banner_1?temp=2");
});

await test("does not expose raw cloud file ids when image URL exchange is unavailable", async () => {
  global.wx = {
    cloud: {
      database() {
        return {
          collection() {
            return buildQuery([
              {
                _id: "case_doc_1",
                caseId: "case_001",
                title: "case_001",
                coverImage: "cloud://image_private",
                isVisible: true,
                sortOrder: 1,
              },
            ]);
          },
        };
      },
      async callFunction() {
        return {
          result: {
            ok: false,
            code: "UNKNOWN_ACTION",
            message: "未知案例管理操作",
          },
        };
      },
    },
  };

  const caseData = loadCommonJS(caseDataPath);
  const { fetchVisibleCases } = loadCommonJS(cloudDataPath, {
    console: {
      ...console,
      warn() {},
    },
    wx: global.wx,
    require(request) {
      if (request === "./caseData") return caseData;
      throw new Error(`Unexpected require: ${request}`);
    },
  });

  const cases = await fetchVisibleCases();

  assert.equal(cases[0].coverImage, "cloud://image_private");
  assert.equal(cases[0].coverImageUrl, "");
});

await test("fetchCaseById tries the document id before the legacy caseId index", async () => {
  const { fetchCaseById, docCalls, whereCalls } = mockCaseLookupData([
    {
      _id: "doc_001",
      caseId: "case_001",
      title: "case_001",
      coverImage: "https://example.com/case.png",
      isVisible: true,
    },
  ]);

  const caseItem = await fetchCaseById("case_001");

  assert.deepEqual(docCalls, ["case_001"]);
  assert.deepEqual(plain(whereCalls), [{ caseId: "case_001", isVisible: true }]);
  assert.equal(caseItem.id, "doc_001");
});

await test("fetchCaseById returns a visible document id without an index fallback", async () => {
  const { fetchCaseById, docCalls, whereCalls } = mockCaseLookupData([
    {
      _id: "doc_visible",
      caseId: "case_visible",
      title: "visible",
      coverImage: "https://example.com/visible.png",
      isVisible: true,
    },
  ]);

  const caseItem = await fetchCaseById("doc_visible");

  assert.deepEqual(docCalls, ["doc_visible"]);
  assert.deepEqual(whereCalls, []);
  assert.equal(caseItem.id, "doc_visible");
});

await test("legacy database readers fail closed and never return video fields", async () => {
  const record = {
    _id: "doc_video",
    caseId: "case_video",
    title: "video",
    coverImage: "https://example.com/visible.png",
    videoFileID: "cloud://production.bucket/wine-packaging/videos/admin/case/video.mp4",
    videoUrl: "https://media.example.com/video.mp4",
    videoPosterFileID: "cloud://production.bucket/wine-packaging/videos/admin/case/poster.webp",
    videoPoster: "https://media.example.com/poster.webp",
    videoDurationSeconds: 60,
    videoFileSizeBytes: 1024,
    isVisible: true,
    sortOrder: 1,
  };
  const lookup = mockCaseLookupData([record]);
  const detail = await lookup.fetchCaseById("doc_video");

  assert.equal(detail.videoUrl, "");
  assert.equal(detail.videoPoster, "");
  assert.equal(detail.videoDurationSeconds, null);
  assert.equal(Object.hasOwn(detail, "videoFileID"), false);
  assert.equal(Object.hasOwn(detail, "videoPosterFileID"), false);
  assert.equal(Object.hasOwn(detail, "videoFileSizeBytes"), false);

  const listReader = mockCloudData([record]);
  const [card] = await listReader.fetchVisibleCases({ includeImageUrls: false });
  assert.equal(card.videoUrl, "");
  assert.equal(card.videoPoster, "");
  assert.equal(card.videoDurationSeconds, null);
  assert.equal(Object.hasOwn(card, "videoFileID"), false);
});

await test("fetchCaseById never exposes a hidden document through either lookup path", async () => {
  const { fetchCaseById, docCalls, whereCalls } = mockCaseLookupData([
    {
      _id: "doc_hidden",
      caseId: "case_hidden",
      title: "hidden",
      coverImage: "https://example.com/hidden.png",
      isVisible: false,
    },
  ]);

  await assert.rejects(
    fetchCaseById("doc_hidden"),
    (error) => error && error.code === "CASE_NOT_FOUND"
  );
  assert.deepEqual(docCalls, ["doc_hidden"]);
  assert.deepEqual(plain(whereCalls), [
    { caseId: "doc_hidden", isVisible: true },
  ]);

  await assert.rejects(
    fetchCaseById("case_hidden"),
    (error) => error && error.code === "CASE_NOT_FOUND"
  );
  assert.deepEqual(docCalls, ["doc_hidden", "case_hidden"]);
  assert.deepEqual(plain(whereCalls), [
    { caseId: "doc_hidden", isVisible: true },
    { caseId: "case_hidden", isVisible: true },
  ]);
});

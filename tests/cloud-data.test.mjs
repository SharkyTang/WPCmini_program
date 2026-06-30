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

function buildQuery(records) {
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
      return {
        data: records.slice(this.offset, this.offset + this.pageSize),
      };
    },
  };
  return query;
}

function mockCloudData(records) {
  const tempUrlBatches = [];
  global.wx = {
    cloud: {
      database() {
        return {
          collection() {
            return buildQuery(records);
          },
        };
      },
      async getTempFileURL({ fileList }) {
        tempUrlBatches.push(fileList.slice());
        return {
          fileList: fileList.map((fileID) => ({
            fileID,
            tempFileURL: `${fileID}?temp=1`,
          })),
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
  };
}

await test("fetches image temp URLs in batches of at most 50 cloud IDs", async () => {
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
    [50, 5]
  );
  assert.equal(cases[0].coverImageUrl, "cloud://image_1?temp=1");
});

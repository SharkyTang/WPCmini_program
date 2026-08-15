import { beforeEach, describe, expect, it } from "vitest";
import { EMPTY_FILTERS } from "../constants";
import { getExpectedVersions } from "./caseLogic";
import { MockAdminApi } from "./mockAdapter";

const DEMO_ACCOUNT = "admin@demo.local";
const DEMO_PASSWORD = "demo1234";

describe("MockAdminApi homepage transaction", () => {
  beforeEach(() => localStorage.clear());

  it("allows one case in multiple slots and clears removed membership atomically", async () => {
    const api = new MockAdminApi();
    await api.signIn(DEMO_ACCOUNT, DEMO_PASSWORD);
    const response = await api.listCases({
      page: 1,
      pageSize: 50,
      filters: { ...EMPTY_FILTERS },
    });
    const candidate = response.items.find((item) => item.isVisible)!;
    await api.setHomeSectionOrder(
      { banner: [candidate._id], popular: [candidate._id], latest: [] },
      getExpectedVersions(response.items),
    );
    const updated = await api.getCase(candidate._id);
    expect(updated.homeSections).toEqual(["banner", "popular"]);
    expect(updated.homeSectionOrder).toEqual({ banner: 1, popular: 1 });

    const beforeClearVersion = updated.version;
    const latestList = await api.listCases({
      page: 1,
      pageSize: 50,
      filters: { ...EMPTY_FILTERS },
    });
    await api.setHomeSectionOrder(
      { banner: [], popular: [], latest: [] },
      getExpectedVersions(latestList.items),
    );
    const cleared = await api.getCase(candidate._id);
    expect(cleared.homeSections).toEqual([]);
    expect(cleared.version).toBe(beforeClearVersion + 1);
  });
});

describe("MockAdminApi mutation idempotency", () => {
  beforeEach(() => localStorage.clear());

  it("returns the original create result when an upload retry reuses its mutation id", async () => {
    const api = new MockAdminApi();
    await api.signIn(DEMO_ACCOUNT, DEMO_PASSWORD);
    const mutationId = "upload-batch-1-image-1";
    const draft = {
      title: "幂等上传案例",
      galleryImages: ["cloud://mock/source.jpg"],
      sourceGalleryImages: ["cloud://mock/source.jpg"],
      galleryThumbnails: ["cloud://mock/thumb.jpg"],
      galleryBanners: ["cloud://mock/banner.jpg"],
      coverImage: "cloud://mock/source.jpg",
      coverThumbnail: "cloud://mock/thumb.jpg",
      coverBanner: "cloud://mock/banner.jpg",
    };

    const created = await api.createCase(draft, mutationId);
    const retried = await api.createCase(draft, mutationId);

    expect(retried).toMatchObject({
      id: created.id,
      caseId: created.caseId,
      version: created.version,
      duplicate: true,
    });
  });

  it("returns the saved version when an update retry reuses its mutation id", async () => {
    const api = new MockAdminApi();
    await api.signIn(DEMO_ACCOUNT, DEMO_PASSWORD);
    const response = await api.listCases({
      page: 1,
      pageSize: 1,
      filters: { ...EMPTY_FILTERS },
    });
    const original = response.items[0];
    const mutationId = "edit-case-retry-1";

    const saved = await api.updateCase(
      original._id,
      { title: `${original.title}（已编辑）` },
      original.version,
      mutationId,
    );
    const retried = await api.updateCase(
      original._id,
      { title: "这次重试不会覆盖上次结果" },
      original.version,
      mutationId,
    );

    expect(retried.title).toBe(saved.title);
    expect(retried.version).toBe(saved.version);
  });

  it("uses single-value semantics for batch price level updates", async () => {
    const api = new MockAdminApi();
    await api.signIn(DEMO_ACCOUNT, DEMO_PASSWORD);
    const response = await api.listCases({
      page: 1,
      pageSize: 2,
      filters: { ...EMPTY_FILTERS },
    });
    const [first, second] = response.items;
    await api.batchPatchCases({
      ids: [first._id, second._id],
      tags: { priceLevel: ["珍藏款"] },
      tagMode: "replace",
      expectedVersions: getExpectedVersions([first, second]),
    });

    expect((await api.getCase(first._id)).priceLevel).toBe("珍藏款");
    expect((await api.getCase(second._id)).priceLevel).toBe("珍藏款");
  });

  it("使用显示别名搜索婚宴案例，保存时仍保留内部值", async () => {
    const api = new MockAdminApi();
    await api.signIn(DEMO_ACCOUNT, DEMO_PASSWORD);
    const response = await api.listCases({
      page: 1,
      pageSize: 50,
      filters: { ...EMPTY_FILTERS, keyword: "喜宴" },
    });

    expect(response.items.length).toBeGreaterThan(0);
    expect(response.items.every((item) => item.scenes.includes("婚宴"))).toBe(true);

    const original = response.items[0];
    const saved = await api.updateCase(
      original._id,
      { title: `${original.title}（别名检查）`, scenes: ["婚宴"] },
      original.version,
      "scene-label-save-test",
    );
    expect(saved.scenes).toEqual(["婚宴"]);
  });
});

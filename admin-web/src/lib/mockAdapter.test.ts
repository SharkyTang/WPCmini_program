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

  it("applies videoPatch atomically and preserves video when the patch is omitted", async () => {
    const api = new MockAdminApi();
    await api.signIn(DEMO_ACCOUNT, DEMO_PASSWORD);
    const candidate = (await api.listCases({
      page: 1,
      pageSize: 1,
      filters: { ...EMPTY_FILTERS },
    })).items[0];

    const withVideo = await api.updateCase(
      candidate._id,
      { notes: candidate.notes },
      candidate.version,
      "video-external-1",
      {
        mode: "external",
        url: "https://cdn.example.com/video.mp4",
        posterUrl: "https://cdn.example.com/poster.jpg",
        durationSeconds: 30,
      },
    );
    expect(withVideo).toMatchObject({
      videoFileID: "",
      videoUrl: "https://cdn.example.com/video.mp4",
      videoPoster: "https://cdn.example.com/poster.jpg",
      videoDurationSeconds: 30,
    });

    const unrelatedUpdate = await api.updateCase(
      candidate._id,
      { notes: "不影响视频" },
      withVideo.version,
      "video-preserve-1",
    );
    expect(unrelatedUpdate.videoUrl).toBe("https://cdn.example.com/video.mp4");

    const cleared = await api.updateCase(
      candidate._id,
      { notes: unrelatedUpdate.notes },
      unrelatedUpdate.version,
      "video-clear-1",
      { mode: "clear" },
    );
    expect(cleared).toMatchObject({
      videoFileID: "",
      videoUrl: "",
      videoPosterFileID: "",
      videoPoster: "",
      videoDurationSeconds: null,
      videoFileSizeBytes: null,
    });
  });

  it("returns explicit safe cleanup results for referenced or already absent files", async () => {
    const api = new MockAdminApi();
    await api.signIn(DEMO_ACCOUNT, DEMO_PASSWORD);
    const candidate = (await api.listCases({
      page: 1,
      pageSize: 1,
      filters: { ...EMPTY_FILTERS },
    })).items[0];
    const referencedFileID = candidate.galleryImages[0];
    const absentFileID = "cloud://mock-env/wine-packaging/videos/demo-admin/absent.mp4";

    await expect(api.cleanupUnreferencedFiles([
      referencedFileID,
      absentFileID,
      referencedFileID,
    ])).resolves.toEqual({
      deletedFileIds: [],
      skippedFileIds: [referencedFileID, absentFileID],
      failedFileIds: [],
    });
  });

  it("permanently deletes only trashed cases and reuses the purge result", async () => {
    const api = new MockAdminApi();
    await api.signIn(DEMO_ACCOUNT, DEMO_PASSWORD);
    const trash = await api.listCases({
      page: 1,
      pageSize: 10,
      filters: { ...EMPTY_FILTERS, trash: true },
    });
    const candidate = trash.items[0];
    const mutationId = "purge-trash-case-1";

    const deleted = await api.permanentlyDeleteCases(
      [candidate._id],
      getExpectedVersions([candidate]),
      mutationId,
    );
    const retried = await api.permanentlyDeleteCases(
      [candidate._id],
      getExpectedVersions([candidate]),
      mutationId,
    );

    expect(deleted.deleted).toBe(1);
    expect(retried).toEqual(deleted);
    const latestTrash = await api.listCases({
      page: 1,
      pageSize: 10,
      filters: { ...EMPTY_FILTERS, trash: true },
    });
    expect(latestTrash.items.some((item) => item._id === candidate._id)).toBe(false);
  });

  it("rejects permanent deletion for a case outside the trash", async () => {
    const api = new MockAdminApi();
    await api.signIn(DEMO_ACCOUNT, DEMO_PASSWORD);
    const active = await api.listCases({
      page: 1,
      pageSize: 1,
      filters: { ...EMPTY_FILTERS },
    });
    const candidate = active.items[0];

    await expect(
      api.permanentlyDeleteCases(
        [candidate._id],
        getExpectedVersions([candidate]),
        "purge-active-case-1",
      ),
    ).rejects.toMatchObject({ code: "CASE_NOT_FOUND" });
  });

  it("discovers only the current administrator pending purge jobs", async () => {
    const api = new MockAdminApi();
    await api.signIn(DEMO_ACCOUNT, DEMO_PASSWORD);
    const now = new Date().toISOString();
    localStorage.setItem("wine-admin-demo-config-override-v1", JSON.stringify({
      writeEnabled: false,
      permanentDeleteEnabled: false,
    }));
    localStorage.setItem("wine-admin-demo-purge-jobs-v1", JSON.stringify({
      "current-admin-mutation": {
        deleted: 1,
        cleanupJobId: "current-admin-job",
        deletedFileCount: 2,
        retainedReferencedCount: 0,
        pendingFileCount: 1,
        clientMutationId: "current-admin-mutation",
        ownerUid: "demo-admin",
        status: "cleanup_release_pending",
        createdAt: now,
        updatedAt: now,
      },
      "other-admin-mutation": {
        deleted: 1,
        cleanupJobId: "other-admin-job",
        deletedFileCount: 0,
        retainedReferencedCount: 0,
        pendingFileCount: 3,
        clientMutationId: "other-admin-mutation",
        ownerUid: "another-admin",
        status: "cleanup_pending",
        createdAt: now,
        updatedAt: now,
      },
    }));

    await expect(api.getAdminConfig()).resolves.toMatchObject({
      writeEnabled: false,
      permanentDeleteEnabled: false,
    });
    await expect(api.listPendingPurgeJobs()).resolves.toEqual([
      expect.objectContaining({
        cleanupJobId: "current-admin-job",
        clientMutationId: "current-admin-mutation",
        pendingFileCount: 1,
      }),
    ]);
    await api.retryPurgeCleanup("current-admin-job");
    await expect(api.listPendingPurgeJobs()).resolves.toEqual([]);

    const jobs = JSON.parse(
      localStorage.getItem("wine-admin-demo-purge-jobs-v1") || "{}",
    ) as Record<string, { pendingFileCount: number }>;
    expect(jobs["other-admin-mutation"].pendingFileCount).toBe(3);
  });

  it("shares upload status and activity without exposing files", async () => {
    const api = new MockAdminApi();
    await api.signIn(DEMO_ACCOUNT, DEMO_PASSWORD);
    await api.registerUploadItems([
      {
        mutationId: "shared-upload-1",
        uploadBatchId: "batch-1",
        title: "共享上传案例",
        imageCount: 2,
        packageTypes: ["整套包装"],
        scenes: ["婚宴"],
        status: "waiting",
      },
    ]);
    await api.updateUploadItemStatus("shared-upload-1", {
      status: "processing",
      title: "共享上传案例",
    });

    const jobs = await api.listSharedUploadItems();
    const activities = await api.listAdminActivity();
    expect(jobs[0]).toMatchObject({
      mutationId: "shared-upload-1",
      status: "processing",
      ownerUid: "demo-admin",
    });
    expect(jobs[0]).not.toHaveProperty("files");
    expect(activities.map((item) => item.action)).toEqual([
      "upload_processing",
      "upload_queued",
    ]);
  });

  it("records move, restore, and permanent-delete case activity once", async () => {
    const api = new MockAdminApi();
    await api.signIn(DEMO_ACCOUNT, DEMO_PASSWORD);
    const active = await api.listCases({
      page: 1,
      pageSize: 1,
      filters: { ...EMPTY_FILTERS },
    });
    const candidate = active.items[0];
    await api.moveCasesToTrash(
      [candidate._id],
      getExpectedVersions([candidate]),
    );
    const trashed = (await api.listCases({
      page: 1,
      pageSize: 50,
      filters: { ...EMPTY_FILTERS, trash: true },
    })).items.find((item) => item._id === candidate._id)!;
    await api.restoreCases([trashed._id], getExpectedVersions([trashed]));
    const restored = await api.getCase(candidate._id);
    await api.moveCasesToTrash([restored._id], getExpectedVersions([restored]));
    const trashedAgain = (await api.listCases({
      page: 1,
      pageSize: 50,
      filters: { ...EMPTY_FILTERS, trash: true },
    })).items.find((item) => item._id === candidate._id)!;
    const mutationId = "purge-case-activity-1";
    await api.permanentlyDeleteCases(
      [trashedAgain._id],
      getExpectedVersions([trashedAgain]),
      mutationId,
    );
    await api.permanentlyDeleteCases(
      [trashedAgain._id],
      getExpectedVersions([trashedAgain]),
      mutationId,
    );

    const activities = (await api.listAdminActivity()).filter(
      (item) => item.caseId === candidate.caseId,
    );
    expect(activities.filter((item) => item.action === "case_moved_to_trash")).toHaveLength(2);
    expect(activities.filter((item) => item.action === "case_restored")).toHaveLength(1);
    expect(activities.filter((item) => item.action === "case_permanently_deleted")).toHaveLength(1);
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
    const list = await api.listCases({
      page: 1,
      pageSize: 50,
      filters: { ...EMPTY_FILTERS },
    });
    const candidate = list.items[0];
    await api.updateCase(
      candidate._id,
      { scenes: ["婚宴"] },
      candidate.version,
      "scene-wedding-alias",
    );

    const searched = await api.listCases({
      page: 1,
      pageSize: 50,
      filters: { ...EMPTY_FILTERS, keyword: "喜宴" },
    });
    expect(searched.items.some((item) => item._id === candidate._id)).toBe(true);
    expect((await api.getCase(candidate._id)).scenes).toEqual(["婚宴"]);
  });
});

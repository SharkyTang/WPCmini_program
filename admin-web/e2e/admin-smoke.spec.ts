import { expect, test } from "@playwright/test";

async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/#/login");
  await page.getByRole("button", { name: "进入管理后台" }).click();
  await expect(page).toHaveURL(/\/#\/cases$/);
  await expect(page.getByRole("heading", { name: "案例管理" })).toBeVisible();
}

async function readMockScenes(page: import("@playwright/test").Page, id: string) {
  return page.evaluate((caseId) => {
    const cases = JSON.parse(localStorage.getItem("wine-admin-demo-cases-v2") || "[]") as Array<{
      _id: string;
      scenes: string[];
    }>;
    return cases.find((item) => item._id === caseId)?.scenes;
  }, id);
}

async function batchChangeFirstCaseScene(
  page: import("@playwright/test").Page,
  mode: "追加" | "移除" | "全部替换",
  sceneLabel: string,
) {
  await page.getByRole("checkbox", { name: "Select row 1", exact: true }).click();
  await page.getByRole("button", { name: "批量操作" }).click();
  await page.getByText("修改标签", { exact: true }).click();
  await expect(page.getByText("批量修改标签 · 1 个案例", { exact: true })).toBeVisible();

  await page.getByRole("combobox", { name: "标签分类" }).click();
  await page
    .locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content")
    .filter({ hasText: "场景" })
    .click();
  await page.locator(".ant-radio-button-wrapper").filter({ hasText: mode }).click();
  await page.getByRole("combobox", { name: "批量标签值" }).click();

  const dropdown = page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)");
  await expect(
    dropdown.locator(".ant-select-item-option-content").filter({ hasText: "婚宴/喜宴" }),
  ).toBeVisible();
  await dropdown
    .locator(".ant-select-item-option-content")
    .filter({ hasText: sceneLabel })
    .click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "应用修改" }).click();
  await expect(page.getByText("已更新 1 个案例的标签", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "Select row 1", exact: true }),
  ).not.toBeChecked();
}

test("管理员可浏览全部首版路由并筛选案例", async ({ page }) => {
  await signIn(page);

  const menuItems = page.getByRole("menuitem");
  await expect(menuItems).toHaveCount(4);
  for (const item of await menuItems.all()) {
    await expect(item).toBeVisible();
    const color = await item.evaluate((element) => getComputedStyle(element).color);
    expect(color, "未选中的侧栏菜单也应使用深色导航上的浅色文字").toMatch(
      /^rgba?\((?:2[0-5]\d|1\d\d),\s*(?:2[0-5]\d|1\d\d),\s*(?:2[0-5]\d|1\d\d)/,
    );
  }

  await expect(page.getByText("共 21 个案例")).toBeVisible();
  const search = page.getByPlaceholder("搜索标题、编号、标签或备注");
  await search.fill("青瓷");
  await expect(page.getByText("共 1 个案例")).toBeVisible();
  await expect(
    page.locator("button.case-title-button").filter({ hasText: "云岭春·青瓷系列" }),
  ).toBeVisible();
  await search.clear();

  await page.getByRole("menuitem", { name: "批量上传" }).click();
  await expect(page.getByRole("heading", { name: "上传队列" })).toBeVisible();
  await expect(page.getByText("并发处理 3 个案例")).toBeVisible();

  await page.getByRole("menuitem", { name: "首页编排" }).click();
  await expect(page.getByText("首页位置与运营标签相互独立")).toBeVisible();
  await expect(page.getByText("首页轮播", { exact: true })).toBeVisible();

  await page.getByRole("menuitem", { name: "回收站" }).click();
  await expect(page.getByText("回收站不会永久删除图片")).toBeVisible();
  await expect(page.getByText("回收站中 3 个案例")).toBeVisible();
});

test("场景别名可显示和搜索，编辑保存仍使用内部值", async ({ page }) => {
  await signIn(page);

  const search = page.getByPlaceholder("搜索标题、编号、标签或备注");
  await search.fill("喜宴");
  await expect(page.getByText("共 2 个案例")).toBeVisible();
  await search.clear();

  await page.getByRole("combobox", { name: "场景筛选" }).click();
  const dropdown = page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)");
  for (const label of ["婚宴/喜宴", "百日/满月", "生日宴", "寿宴", "乔迁宴"]) {
    await expect(
      dropdown.locator(".ant-select-item-option-content").filter({ hasText: label }),
    ).toBeVisible();
  }
  await dropdown
    .locator(".ant-select-item-option-content")
    .filter({ hasText: "婚宴/喜宴" })
    .click();
  await page.keyboard.press("Escape");
  await expect(page.getByText("共 2 个案例")).toBeVisible();

  await page.goto("/#/cases/mock-001/edit");
  const sceneField = page.locator(".ant-form-item").filter({ hasText: "场景" });
  await expect(sceneField.getByText("婚宴/喜宴", { exact: true })).toBeVisible();
  await page.getByLabel("案例标题").fill("山河酿·场景别名验证");
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(page.getByText("案例已保存", { exact: true })).toBeVisible();

  const savedScenes = await readMockScenes(page, "mock-001");
  expect(savedScenes).toEqual(["婚宴"]);

  await page.reload();
  await expect(sceneField.getByText("婚宴/喜宴", { exact: true })).toBeVisible();
});

test("批量场景追加、移除和替换均保存内部值", async ({ page }) => {
  await signIn(page);

  await batchChangeFirstCaseScene(page, "追加", "百日/满月");
  await expect.poll(() => readMockScenes(page, "mock-001")).toEqual(["婚宴", "百日/满月"]);

  await batchChangeFirstCaseScene(page, "移除", "婚宴/喜宴");
  await expect.poll(() => readMockScenes(page, "mock-001")).toEqual(["百日/满月"]);

  await batchChangeFirstCaseScene(page, "全部替换", "乔迁宴");
  await expect.poll(() => readMockScenes(page, "mock-001")).toEqual(["乔迁宴"]);
});

test("编辑深链刷新可恢复，离开未保存内容会被拦截", async ({ page }) => {
  await signIn(page);
  await page.goto("/#/cases/mock-001/edit");
  await expect(page.getByRole("heading", { name: "编辑案例" })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("案例标题")).toHaveValue("山河酿·典藏礼盒");

  await page.getByLabel("案例标题").fill("山河酿·未保存修改");
  await page.getByRole("menuitem", { name: "批量上传" }).click();
  await expect(page.locator(".ant-modal-confirm-title")).toHaveText(
    "离开并放弃未保存的修改？",
  );
  await page.getByRole("button", { name: "继续编辑" }).click();
  await expect(page).toHaveURL(/\/#\/cases\/mock-001\/edit$/);

  await page.getByRole("menuitem", { name: "批量上传" }).click();
  await page.getByRole("button", { name: "放弃并离开" }).click();
  await expect(page).toHaveURL(/\/#\/cases\/upload$/);
});

test("上传文件刷新后仍可继续，并可安全退出登录", async ({ page }) => {
  await signIn(page);
  await page.goto("/#/cases/upload");

  await page.locator('input[type="file"]').setInputFiles({
    name: "刷新恢复案例.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await expect(page.locator(".queue-title-input input")).toHaveValue("刷新恢复案例");
  await expect(page.getByText("等待上传", { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.locator(".queue-title-input input")).toHaveValue("刷新恢复案例");
  await expect(page.getByText("等待上传", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "开始上传" }).click();
  await expect(page.getByText("待补标签", { exact: true })).toBeVisible({
    timeout: 10_000,
  });

  await page.getByRole("button", { name: "管理员账户菜单" }).click();
  await page.getByText("退出登录", { exact: true }).click();
  await expect(page).toHaveURL(/\/#\/login$/);
});

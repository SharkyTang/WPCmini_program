import { expect, test } from "@playwright/test";

async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/#/login");
  await page.getByRole("button", { name: "进入管理后台" }).click();
  await expect(page).toHaveURL(/\/#\/cases$/);
  await expect(page.getByRole("heading", { name: "案例管理" })).toBeVisible();
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

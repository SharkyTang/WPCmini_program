# Design QA — 首页轮播图固定比例

- Source visual truth: `/var/folders/dw/b62m5m1j0ygdwflpyv2mqykc0000gn/T/TemporaryItems/NSIRD_screencaptureui_rENdEv/截屏2026-07-30 20.24.38.png`
- Implementation screenshot: `/private/tmp/home-carousel-fixed-ratio-after.jpg`
- Side-by-side comparison: `/private/tmp/home-carousel-fixed-ratio-comparison.png`
- Viewport: 微信开发者工具 iPhone 15 Pro Max 模拟器，界面缩放 `63%`
- State: 将右侧案例 “7” 手动滑动到中间

## Full-view comparison evidence

- 修复前，当前案例会从侧卡的 `aspectFill` 切换为 `aspectFit`，出现上下色块并产生明显的缩小感。
- 修复后，主卡和左右侧卡始终使用同一个 `aspectFill` 裁切规则；案例从侧边移动到中间时不再切换显示比例。

## Focused region comparison evidence

- 对比图上半部分记录完整轮播区域，下半部分放大中间案例卡。
- 修复后的中间卡不再出现上下黄色留白，和两侧案例保持一致的铺满方式与缩放比例。

## Findings

- 本次目标没有遗留可执行的 P0、P1 或 P2 问题。
- 字体、文案、颜色、卡片尺寸和整体布局均未改动。
- 图片显示在所有轮播状态中统一为 `aspectFill`。
- 取舍：`aspectFill` 可能裁掉原图边缘；这是为遵守两侧案例的比例并避免切换时缩放而采用的统一规则。
- 控制台中历史图片临时地址的 `403`、`404` 与本次显示模式修改无关。

## Interaction checks

- 手动滑动后，右侧案例 “7” 成为主卡，图片比例和裁切方式保持不变。
- 自动轮播、循环轮播、点击案例、标题跟随当前项等原有逻辑未改动。
- 微信开发者工具“问题”面板为 0 个问题。

## Comparison history

1. 原实现混用 `aspectFill` 与 `aspectFit`，案例进入中间时出现可见的比例跳变。
2. 将轮播图片统一为固定的 `aspectFill`。
3. 修复后再次滑动并对比，确认进入中间时不再因图片模式切换而改变比例。

## Final result

final result: passed

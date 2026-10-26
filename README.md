# 酒包装灵感库 · WPC Mini Program

面向私人定制酒包装业务的案例展示与管理项目。客户可以在微信中浏览设计案例、组合筛选参考方向并提交定制需求；商家可以维护案例、首页展示、需求和通知。

仓库同时提供本地图片分类工具，将已有案例图片整理为结构化数据，再导入微信云开发（CloudBase）。当前案例分类以白酒包装为主。

## 版本与入口

| 版本 | 内容 | 入口 |
| --- | --- | --- |
| `main` | 微信小程序、云函数、本地图片分类工具、数据维护脚本 | 下方功能与启动说明 |
| `codex/expand-scene-catalog` | 在小程序基础上扩展电脑管理后台、案例视频、客户需求跟进与回复通知 | [开发分支](https://github.com/SharkyTang/WPCmini_program/tree/codex/expand-scene-catalog) · [后台说明](https://github.com/SharkyTang/WPCmini_program/blob/codex/expand-scene-catalog/admin-web/README.md) |

下文默认对应 `main`。扩展分支的功能需要切换分支并完成相应配置；代码中的功能实现不代表已在生产环境启用。

## 主要功能

### 微信小程序

- **案例浏览**：首页轮播、热门产品、最新产品及案例详情。
- **分类检索**：关键词搜索，按酒类、包装内容、风格、价位感、使用场景等条件筛选。
- **图片查看**：案例多图展示、预览与保存，单个案例最多 9 张图库图片。
- **个人中心**：头像昵称、收藏、浏览记录、消息通知、意见反馈及隐私说明。
- **定制沟通**：提交定制需求、查看商家联系方式。

### 小程序管理功能

- 新增和编辑案例，维护分类标签、图库、排序、置顶及显示状态。
- 配置首页轮播、热门和最新产品展示位置。
- 查看和筛选定制需求，更新处理状态、维护内部备注。
- 管理消息通知及商家联系资料。

管理操作由云函数检查管理员身份；需求、案例、通知和联系资料可分别配置角色白名单。

### 本地图片分类工具

- 选择本地文件夹或多张 JPG、JPEG、PNG 图片，自动生成案例编号。
- 手动标注酒类、包装内容、风格、价位感、工艺、场景和状态。
- 在浏览器中保存标注进度，导出压缩后的 JPG 图片与 `cases.json`。
- 可选 AI 风格建议，支持单张和小批量识别、人工确认及用量估算；场景等其他字段仍由人工填写。

## 技术栈与目录

| 部分 | 技术 |
| --- | --- |
| 微信小程序 | JavaScript、WXML、WXSS、微信云开发 |
| 云端服务 | Node.js 云函数、CloudBase 文档数据库与云存储 |
| 图片分类工具 | 原生 JavaScript、HTML、CSS、Node.js 本地服务 |
| 数据维护 | CloudBase Node SDK、Sharp、导入与备份脚本 |
| 扩展分支电脑后台 | React、TypeScript、Vite、Ant Design |

```text
WPCmini_program/
├── miniprogram/
│   ├── project.config.json    # 微信开发者工具项目配置
│   ├── miniprogram/           # 小程序页面、组件与数据服务
│   ├── cloudfunctions/       # 案例、用户、需求、通知等云函数
│   └── uploadCloudFunction.sh # 云函数部署清单
├── docs/                     # 产品、配置、部署与运维说明
├── scripts/                  # 数据导入、图片变体、备份与恢复
├── tests/                    # 根目录回归测试
├── .github/workflows/        # GitHub Actions 检查
├── index.html                # 本地图片分类工具
├── app.js / classifierLogic.mjs
├── aiStyleServer.mjs          # 可选 AI 风格建议服务
└── server.mjs                # 本地开发服务入口
```

## 快速开始

### 1. 获取项目

根目录 CI 使用 Node.js 20；电脑后台使用 Node.js 22，详见该分支的后台说明。

```bash
git clone https://github.com/SharkyTang/WPCmini_program.git
cd WPCmini_program
npm ci
```

### 2. 运行图片分类工具

```bash
npm run dev
```

浏览器打开 [http://localhost:4173](http://localhost:4173)。该命令启动网页分类工具，微信小程序需使用微信开发者工具打开。

手动分类无需配置 AI 服务。使用 AI 风格建议时，需在本机服务端配置 `OPENAI_API_KEY`；可通过 `OPENAI_STYLE_MODEL` 指定模型。调用会把所选图片的预览图发送给 OpenAI，返回建议后由人工决定是否采用。界面中的费用是估算值。

本地服务用于开发和数据整理，请勿直接暴露到公网。服务端密钥不得提交到仓库或放入小程序、网页前端代码。

### 3. 打开微信小程序

1. 安装微信开发者工具，导入仓库中的 **`miniprogram/`** 目录，该目录包含 `project.config.json`。
2. 配置自己的小程序 AppID，并修改 `miniprogram/miniprogram/envList.js` 中的云环境映射。
3. 在目标 CloudBase 环境中准备数据库、云存储、权限规则、管理员角色及所需云函数；函数清单见 `miniprogram/uploadCloudFunction.sh`。
4. 按部署文档配置环境变量、索引和通知相关设置，再编译与预览。

> 当前仓库的开发版、体验版和正式版共用现有生产环境。首次运行前请核对并替换为自己的环境；在现有配置下，开发工具中的写操作也可能影响生产数据。详见[发布安全与环境配置](docs/发布安全与环境配置.md)。

### 4. 准备案例数据

使用分类工具导出后，将文件放在以下位置：

```text
export/
├── cases.json
└── optimized-images/
    ├── case_001.jpg
    └── case_002.jpg
```

先检查导入内容：

```bash
npm run import:cases:dry
```

该命令只检查文件并预览数据。正式导入会上传图片、写入 `wine_packaging` 集合，执行前应明确指定目标环境并配置服务端凭据，步骤见[批量导入案例数据](docs/批量导入案例数据.md)。

## 电脑管理后台与扩展功能

电脑后台位于 [`codex/expand-scene-catalog` 分支](https://github.com/SharkyTang/WPCmini_program/tree/codex/expand-scene-catalog)的 `admin-web/` 目录，支持案例管理、批量图片上传、首页配置和回收站。该分支还包含案例视频、客户查看自己的需求、管理员认领与回复、邮件提醒及订阅通知相关实现。

```bash
git switch codex/expand-scene-catalog
cd admin-web
nvm use
npm ci
npm run dev
```

`nvm use` 需要已安装 nvm 及 Node.js 22，也可自行切换到 Node.js 22 后运行其余命令。后台开发环境默认使用 Mock 数据，演示账号及真实 CloudBase 接入方法见[后台 README](https://github.com/SharkyTang/WPCmini_program/blob/codex/expand-scene-catalog/admin-web/README.md)。

案例视频上传与前台展示分别受 `VIDEO_UPLOAD_ENABLED`、`VIDEO_DISPLAY_ENABLED` 控制，默认关闭；需求提醒也依赖通知开关、模板、用户授权或邮件服务配置。启用步骤见该分支的[发布说明](https://github.com/SharkyTang/WPCmini_program/blob/codex/expand-scene-catalog/docs/发布安全与环境配置.md)和[需求通知与跟进部署说明](https://github.com/SharkyTang/WPCmini_program/blob/codex/expand-scene-catalog/docs/定制需求通知与跟进部署说明.md)。

## 测试与检查

在仓库根目录运行：

```bash
npm test
```

测试覆盖分类逻辑、小程序页面与数据服务、云函数、数据维护脚本等。GitHub Actions 还会检查 JavaScript 语法、空白字符和小程序包体预算，配置见 [CI 工作流](.github/workflows/ci.yml)。这些检查不替代真机验证和云端部署验收。

## 项目文档

- [图片分类工具](docs/图片分类工具.md)：图片整理与导出流程。
- [批量导入案例数据](docs/批量导入案例数据.md)：数据格式、导入参数与云存储上传。
- [发布安全与环境配置](docs/发布安全与环境配置.md)：云环境、管理员角色与发布要求。
- [性能优化部署与验收清单](docs/性能优化部署与验收清单.md)：图片、缓存及包体相关配置。
- [消息通知广播部署说明](docs/消息通知广播部署说明.md)：广播任务与通知部署。
- [个人资料云端上线清单](docs/个人资料云端上线清单.md)：用户资料相关配置。
- [隐私与数据生命周期说明](docs/隐私与数据生命周期说明.md)：个人资料及业务数据处理。
- [云数据备份与恢复](docs/云数据备份与恢复.md)：数据备份和恢复操作。

部分产品规划与 quickstart 文档保留了早期设计记录；判断当前能力时，请结合所选分支的源码与部署说明。

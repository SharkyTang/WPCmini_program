# 电脑端案例管理后台

独立 React + TypeScript + Vite + Ant Design 应用。不会读取或暴露仓库中的服务端 Secret。

## 本地演示

```bash
nvm use
npm install
npm run dev
```

开发环境默认启用 `VITE_USE_MOCKS=true`，使用账号 `admin@demo.local`、密码 `demo1234`。案例与首页演示数据保存在当前浏览器 localStorage；待处理上传文件保存在 IndexedDB，刷新后仍可用同一任务号继续重试，建档完成或移除队列项时会清理本地文件副本。

## CloudBase 配置

复制 `.env.example` 为 `.env.local`，设置：

- `VITE_USE_MOCKS=false`
- `VITE_CLOUDBASE_ENV_ID`
- `VITE_CLOUDBASE_REGION`
- `VITE_CLOUDBASE_PUBLISHABLE_KEY`

Publishable Key、环境 ID 和地域可以进入浏览器；不要填写 SecretId、SecretKey 或 OpenAI Key。管理员账号需提前在 CloudBase 控制台创建，并在控制台关闭公开注册和匿名登录。

## 管理员身份与永久删除

`caseAdmin` 还需要在服务端配置以下环境变量，真实 UID 和显示名只放在 CloudBase 控制台，不进入前端构建：

- `CASE_ADMIN_UIDS`：允许使用后台的 CloudBase UID，逗号分隔。
- `CASE_ADMIN_OPENIDS`：允许使用小程序案例管理的 OPENID；未配置时继续回退到 `ADMIN_OPENIDS`。
- `CASE_ADMIN_DISPLAY_NAMES`：UID 到显示名的 JSON，例如 `{"uid-a":"管理员甲","uid-b":"管理员乙"}`。
- `ADMIN_WEB_WRITE_ENABLED`：电脑后台总写入开关。
- `ADMIN_PERMANENT_DELETE_ENABLED`：回收站永久删除开关。
- `VIDEO_UPLOAD_ENABLED`：案例视频云文件上传开关，默认为关闭。
- `VIDEO_DISPLAY_ENABLED`：普通用户详情页视频返回开关，默认为关闭。

部署前创建 `case_admin_purge_jobs`、`case_admin_video_upload_intents` 两个文档型数据库集合。客户端权限规则保存在 `cloudbase/`，这两个内部集合均拒绝客户端直接读写。

案例视频只允许在已有案例编辑器中上传，限制为单个 MP4、100MB、120 秒和 1080p；自定义封面支持 JPEG、PNG、WebP，最大 5MB。文件使用 `wine-packaging/videos/` 独立目录，不经过现有图片变体处理。

直传还需要云存储安全规则配合：不能只依赖界面开关和随机路径。`cloudbase/storage-video.rules.template.json` 仅是合并模板，不能原样部署；上线前必须导出完整生产规则，将占位符替换为与 `CASE_ADMIN_UIDS` 及生效中的案例管理 OPENID 白名单（`CASE_ADMIN_OPENIDS`，缺失时为 `ADMIN_OPENIDS`）一致的真实身份，只限制 `wine-packaging/videos/` 路径，并保持其他路径的原有创建者读写语义。规则生效后必须分别执行管理员上传正测和普通账号直传负测。

上线时先让永久删除开关保持 `false`，完成旧功能冒烟后，再使用生产环境中专门创建的唯一隐藏测试案例验收。生产永久删除不可通过代码回滚，只能清理确认未被引用的测试文件。

## 验证

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
```

E2E 默认调用本机最新版 Chrome；CI 可按 Playwright 官方方式安装 Chrome/Chromium 后运行。

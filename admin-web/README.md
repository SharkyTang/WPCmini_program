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

## 管理员协作与永久删除

`caseAdmin` 还需要在服务端配置以下环境变量，真实 UID 和显示名只放在 CloudBase 控制台，不进入前端构建：

- `CASE_ADMIN_UIDS`：允许使用后台的 CloudBase UID，逗号分隔。
- `CASE_ADMIN_DISPLAY_NAMES`：UID 到显示名的 JSON，例如 `{"uid-a":"管理员甲","uid-b":"管理员乙"}`。
- `ADMIN_WEB_WRITE_ENABLED`：电脑后台总写入开关。
- `ADMIN_ACTIVITY_SYNC_ENABLED`：管理员动态同步开关。
- `ADMIN_PERMANENT_DELETE_ENABLED`：回收站永久删除开关。

部署前创建 `case_admin_upload_jobs`、`case_admin_activity_feed`、`case_admin_purge_jobs` 三个文档型数据库集合。客户端权限规则保存在 `cloudbase/`：活动流仅允许当前 `viewerUid` 读取，另外两个内部集合拒绝客户端直接读写。为活动流建立 `viewerUid` 升序、`createdAt` 降序的组合索引。

上线时先让两个新增功能开关保持 `false`，部署向后兼容的云函数和静态站点并完成旧功能冒烟，再在 staging 依次开启。生产永久删除不可通过代码回滚，必须只用专门创建的隐藏测试案例完成首次验证。

## 验证

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
```

E2E 默认调用本机最新版 Chrome；CI 可按 Playwright 官方方式安装 Chrome/Chromium 后运行。

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

## 验证

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
```

E2E 默认调用本机最新版 Chrome；CI 可按 Playwright 官方方式安装 Chrome/Chromium 后运行。

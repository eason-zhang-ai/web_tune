# Web Tune Agent 开发指南

本文件约束在本仓库中工作的 AI Agent 和自动化开发工具。目标是让每次改动保持纯前端、可测试、可在 GitHub Pages 发布，并尊重用户隐私。

## 工作范围

- 主应用位于 `tuner-app/`；根目录仅放仓库级文档、忽略规则与 GitHub 工作流。
- 这是静态站点。不要引入后端、账号、云同步、分析追踪或上传音频的功能，除非用户明确要求。
- 默认校准为 A4 = 440 Hz。调弦数据应沿用 `Tuning` 与 `StringTarget` 模型，而不是在 UI 中散落硬编码频率。
- 原始参考图不得直接作为产品资源使用；仅可用于视觉比对。视觉资产应使用原创文件并放在 `tuner-app/public/assets/`。

## 代码约定

- UI 与浏览器交互写在 `tuner-app/src/App.tsx` 和 `tuner-app/src/styles.css`；音高计算和可独立测试的逻辑写在 `tuner-app/src/tuner-core.mjs`。
- 保持 TypeScript/React 与现有 Vite 配置。避免为小功能增加大型依赖。
- 音频分析必须留在客户端。清理音频资源：停止时断开节点、停止音轨并关闭 `AudioContext`。
- 自动选弦须保留音量门限、帧平滑与滞后，避免稳定音频下目标弦频繁跳动。
- 键盘可操作性、窄屏布局、颜色对比和权限 / 错误状态属于功能的一部分，不应在视觉迭代中回退。
- 自定义调弦只用 `localStorage` 持久化，并处理无效或过期的存储值。
- 导入配置只能在浏览器内读取 GitHub 文件页、Raw 或 Gist 的公开 JSON；导出文件应保持 `web-tune/tuning` 可移植格式。导入数据在写入 `localStorage` 前必须校验名称和六根弦的音名/八度。

## 开发与验证

从仓库根目录执行：

```bash
cd tuner-app
npm ci
npm run dev
npm test
npm run build
npm run test:sites
```

- 增加或修改音高算法、频率映射、cents、自动选弦时，更新 `tests/tuner-core.test.mjs`。
- 不要手动提交 `tuner-app/dist/`、`node_modules/` 或本机系统文件。
- `scripts/prepare-sites-build.mjs`、`worker/index.js`、`.openai/hosting.json` 和 `tests/sites-worker.test.mjs` 是构建兼容层；除非任务明确涉及它们，否则保持原样。
- 视觉改动完成后，按 `tuner-app/design-qa.md` 的基准在 732 × 832 视口验收，并额外检查 390 px 窄屏无横向溢出。

## 发布

- GitHub Pages 工作流是 `.github/workflows/deploy-pages.yml`。
- 推送 `main` 会构建并发布 `tuner-app/dist/client`；Vite 的 `base` 必须保持适配仓库路径 `/web_tune/`。
- 发布前确认 `npm test`、`npm run build` 和 `npm run test:sites` 均成功。
- 除非用户明确要求，不要修改仓库的 Pages Source、仓库设置或执行破坏性 Git 操作。

## 提交要求

- 提交应聚焦单一意图，提交信息使用简洁的 Conventional Commit 风格，例如 `feat: add alternate tunings`。
- 保留用户已有的未提交变更；只暂存和提交本次任务涉及的文件。
- 在交付说明中写明改动、验证结果，以及任何需要用户在 GitHub 设置中完成的操作。

# Web Tune

一款纯前端的六弦吉他调音器。它在浏览器中使用 Web Audio API 分析麦克风输入，默认提供标准调弦（E2–A2–D3–G3–B3–E4），并支持预设与本地保存的自定义调弦。

在线版本：<https://eason-zhang-ai.github.io/web_tune/>

## 功能

- 实时检测基频，并以 cents 显示偏低 / 偏高；±5 cents 视为已调准。
- 自动识别最接近的弦，使用音量门限、短帧平滑和目标弦滞后减少跳弦。
- 点按琴头两侧弦钮即可锁定手动调弦目标。
- 内置标准、Drop D、D Standard、Open G、Open D 调弦。
- 支持为六根弦逐一设置音名与八度，保存、切换和删除自定义方案。
- 所有音频分析均在本机浏览器完成；不上传、保存或传输录音。

## 技术栈

- React 19、TypeScript、Vite
- Web Audio API（`getUserMedia`、`AnalyserNode`）
- 自相关基频检测，A4 = 440 Hz
- `localStorage` 保存自定义调弦与最近选择
- GitHub Actions + GitHub Pages 静态发布

## 本地开发

需要 Node.js 22（与 CI 保持一致）。

```bash
cd tuner-app
npm ci
npm run dev
```

开发服务器会输出本地地址。麦克风只能在安全上下文中使用：本地 `localhost` 或 HTTPS 页面均可；部署后的 GitHub Pages 默认满足 HTTPS 要求。

## 验证

```bash
cd tuner-app
npm test          # 音高、cents、识别与滞后逻辑
npm run build     # Vite 静态构建与 Pages 产物准备
npm run test:sites
```

`npm run build` 的可发布静态文件位于 `tuner-app/dist/client`，该目录不提交到 Git。

## 项目结构

```text
.
├── .github/workflows/deploy-pages.yml  # GitHub Pages 工作流
├── AGENTS.md                           # AI / Agent 开发协作约定
├── README.md
└── tuner-app/
    ├── public/assets/                  # 原创琴头与网格视觉资产
    ├── src/App.tsx                     # 页面、麦克风生命周期与交互
    ├── src/tuner-core.mjs              # 音高检测与调弦模型
    ├── tests/                          # 核心逻辑与静态产物测试
    └── design-qa.md                    # 参考图视觉验收记录
```

## 部署到 GitHub Pages

向 `main` 推送会自动触发 `.github/workflows/deploy-pages.yml`：安装依赖、构建 `tuner-app`，再将 `tuner-app/dist/client` 发布到 Pages。

仓库首次启用时，请在 GitHub 的 **Settings → Pages** 中将 Source 设为 **GitHub Actions**。站点的 Vite `base` 已配置为仓库子路径 `/web_tune/`。

## 隐私与浏览器支持

- 调音时仅请求麦克风权限；不建立后端连接，也不保存原始音频。
- 用户拒绝权限、浏览器不支持或当前没有有效信号时，界面会给出明确状态。
- 推荐使用最新版 Chrome、Edge、Safari 或 Firefox，并在安静环境下单独拨动一根弦。

## 贡献

提交前请至少运行 `npm test` 和 `npm run build`。涉及音频检测、调弦数据或界面交互的改动，也请同步补充测试；视觉改动请参考 `tuner-app/design-qa.md` 保持与设计基准一致。

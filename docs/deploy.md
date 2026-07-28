# 部署到 Cloudflare Pages

「舞蹈老师」现已是**纯前端静态 SPA**：视频的音轨提取（ffmpeg.wasm）与节拍 / BPM
检测（essentia.js）全部在浏览器内完成，无任何后端运行时。下方是把 `frontend/`
目录部署到 Cloudflare Pages 的步骤。

## 1. 前置条件

- 一个 Cloudflare 账号（Free 套餐即可，零成本、免绑卡、无冷启动）。
- 把本仓库推送到 GitHub / GitLab，或直接用 Cloudflare Dashboard 拖拽上传。

## 2. 在 Cloudflare Pages 创建项目

1. 登录 Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages**。
2. 选择 **Connect to Git**，授权并选中本仓库。
3. 构建配置（也可写进 `wrangler.toml`，Dashboard 会自动读取）：

   | 项 | 值 |
   |---|---|
   | 构建命令 (Build command) | `npm run build` |
   | 构建输出目录 (Build output directory) | `dist` |
   | 根目录 (Root directory) | `frontend` |
   | 框架预设 (Framework preset) | `Vite` |

   > 说明：`npm run build` 已通过 `prebuild` 钩子自动执行 `npm run copy:wasm`，
   > 把 ffmpeg / essentia 的 WASM 资源拷贝到 `public/wasm/` 并随 `dist/` 一起产出。
   > 若你在本机先 `npm install` 再部署，也可保持默认。

4. 点击 **Save and Deploy**。首次构建约 1–2 分钟（需下载并打包 WASM 资源）。

## 3. 跨源隔离响应头（ffmpeg.wasm 多线程必需）

`public/_headers` 已在仓库内，Vite 构建时会原样拷贝到 `dist/` 根目录，Cloudflare
Pages 会自动生效，无需额外配置：

```
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
```

这两条头会让页面进入 **cross-origin isolated** 状态，`SharedArrayBuffer` 可用，
ffmpeg.wasm 自动启用**多线程**核心（更快）。若部署平台不支持该头，应用会自动
降级到单线程核心（更慢但兼容，详见 `src/analysis/crossOrigin.ts`）。

> 兜底：若 `_headers` 未生效，可在 Cloudflare Pages 控制台
> **Settings → Headers** 手动添加这两条（与上方一致）。

## 4. 自定义域名（可选）

在 **Pages 项目 → Custom domains** 中绑定你的域名，按提示添加 DNS 记录即可。
静态资源全站 CDN 加速，无服务器健康检查。

## 5. 本地预览

```bash
cd frontend
npm install
npm run copy:wasm      # 拷贝 WASM 资源到 public/wasm/
npm run build          # 产出 dist/
npm run preview        # 起本地静态服务，默认 http://localhost:4173
```

> 注意：本地 `vite preview` / 直接打开 `dist/index.html` 时，浏览器的
> cross-origin isolation（COOP/COEP）取决于静态服务器是否发出对应响应头。
> `npm run preview` 不会自动加这两行头，因此本地默认走**单线程** ffmpeg 核心；
> 功能完全可用，只是稍慢。要本地验证多线程，可用任意能加响应头的静态服务器
> （如 `npx serve -l 4173` 配合自定义头，或部署到 Pages 后验证）。

## 6. 对齐验收（可选，离线）

`scripts/validate-alignment.mjs` 用 essentia.js 离线计算样本 BPM / beats，并与
`samples/baseline.json` 中预存的 librosa 基线对比，输出 BPM 误差、拍偏移、8 拍
边界一致率，并判定是否 ≥ 90%：

```bash
cd frontend
npm run validate:alignment
```

无真实样本时脚本会自生成已知 BPM 的节拍轨进行自测，无需已删除的 backend venv。

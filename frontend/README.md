# 舞蹈老师 · 前端 (React + Vite + MUI + Tailwind)

舞蹈教学的浏览器端：上传 → 分析进度 → 小节慢放带练 → 本地进度保存。

## 技术栈

- React 18 + Vite 5
- MUI v5（`@mui/material` + `@mui/icons-material`）
- Tailwind CSS 3
- react-router-dom 6
- zustand 4（教学页运行态）
- axios 1（HTTP 调用）

## 依赖安装

```bash
npm install
```

> 若网络受限，可按 `package.json` 中的版本清单手动安装对应依赖；确保
> `react@^18`、`@mui/material@^5`、`@mui/icons-material@^5`、`tailwindcss@^3`、
> `react-router-dom@^6`、`zustand@^4`、`axios@^1` 均可用。

## 开发运行

```bash
npm run dev        # Vite dev server，默认 http://localhost:5173
```

开发期 Vite 已配置代理：`/api` → `http://localhost:8000`（见 `vite.config.ts`），
因此无需额外配置 CORS 即可联调后端。

如需指向不同后端基址，可设置环境变量（默认 `/api/v1`）：

```bash
VITE_API_BASE=/api/v1 npm run dev
```

## 类型检查 / 构建

```bash
npm run typecheck   # tsc --noEmit
npm run build       # 产物输出到 dist/，可由后端单端口托管
```

## 路由

| 路径 | 页面 |
|---|---|
| `/` | 上传页 |
| `/analyze/:taskId` | 分析进度页（轮询，done 自动跳教学页） |
| `/lesson/:taskId` | 教学播放页（核心：小节列表 / 慢放 / 循环 / 节拍叠加 / 镜像） |
| `/progress` | 我的课程 / 进度页 |

## 关键模块

- `src/hooks/useBeatSync.ts` — 核心节拍同步引擎（rAF 读 `video.currentTime` → 定位小节/拍号 → 越过拍触发脉冲；慢放不影响对齐）。
- `src/store/lessonStore.ts` — 教学页运行态（当前节、速度、镜像、循环、已学会）。
- `src/hooks/useLocalProgress.ts` — 进度本地持久化（localStorage，>50KB 自动降级 IndexedDB）。
- `src/components/VideoPlayer.tsx` + `BeatOverlay.tsx` — 播放器 + 节拍计数叠加。

## 说明

- 视频由后端 `GET /api/v1/video/{taskId}` 流式返回，前端通过 `VITE_API_BASE` 拼接地址。
- 进度以 `videoId`（文件身份哈希）为键保存在 `dance-teacher:progress:v1`，重开自动回到上次小节（断点续学）。

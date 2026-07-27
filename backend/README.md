# 舞蹈老师 · 后端 (FastAPI)

音频分析服务：提取音轨 → BPM / 节拍点检测 (librosa) → 按 8 拍切分为小节 → 结构化 JSON。

## 目录结构

```
backend/
├── requirements.txt
└── app/
    ├── main.py                # FastAPI 入口 (CORS / 路由 / /health)
    ├── core/config.py         # 路径 / 上限 / CORS 配置
    ├── routers/
    │   ├── upload.py          # POST /api/v1/upload + GET /api/v1/video/{taskId}
    │   └── analysis.py        # 状态 / 结果 / 重试 / 重算
    ├── services/
    │   ├── audio_extractor.py # ffmpeg 提取 16kHz mono wav
    │   ├── beat_detector.py   # librosa BPM / beat 检测 (懒加载)
    │   ├── segmenter.py       # 8 拍聚合
    │   └── task_manager.py    # 任务状态机 (内存 + json 落盘)
    ├── schemas/analysis.py    # Pydantic: Segment / AnalysisResult / TaskStatus ...
    ├── models/task.py         # 任务数据模型
    └── utils/video.py         # 格式/大小/时长校验 + 链接下载
```

## 依赖安装

推荐使用团队托管的 Python（或你本地的 3.10+）：

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

> ⚠️ **系统级依赖**：分析依赖 `ffmpeg` 命令行（用于音频提取与时长探测）。
> 本机未安装会导致上传后分析失败。
> - macOS:  `brew install ffmpeg`
> - Ubuntu: `sudo apt install ffmpeg`
> - 验证：  `ffmpeg -version` 与 `ffprobe -version` 均可执行。

> `librosa` 会拉入 `numba` / `llvmlite`，部分平台需要编译器来构建 wheel；
> 多数平台有预编译 wheel，安装通常顺利。

## 运行

```bash
uvicorn app.main:app --reload --port 8000
```

健康检查（均可用）：

```bash
curl http://localhost:8000/health
curl http://localhost:8000/api/v1/health
```

## API 速览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET  | `/health` · `/api/v1/health` | 健康检查 |
| POST | `/api/v1/upload` | 上传视频（multipart `file` 或 JSON `{ url }`）→ `{taskId,status}` |
| GET  | `/api/v1/analysis/{taskId}` | 任务状态 + 进度（done 时含 result） |
| GET  | `/api/v1/analysis/{taskId}/result` | 分析结果 `AnalysisResult` |
| POST | `/api/v1/analysis/{taskId}/retry` | 失败重试 |
| POST | `/api/v1/analysis/{taskId}/recompute` | 重算节拍（`mode`: `auto`/`fixed120`/`manual_first_beat`） |
| GET  | `/api/v1/video/{taskId}` | 流式返回源视频（供播放器使用，支持 Range） |

任务状态机：`queued → extracting → beat_detecting → segmenting → done / failed`。
前端每 1000ms 轮询一次。

## 说明

- 任务在后台线程中运行，结果落盘到 `backend/data/tasks/*.json`，重启不丢失。
- 上传文件存于 `backend/data/uploads/`，音频存于 `backend/data/wav/`。
- `librosa` 与 `numpy` 在分析函数内**懒加载**，因此即使未安装重依赖，`GET /health` 与路由注册也能正常启动；只有在真正分析时才会用到它们。
- 错误统一返回 `{ code, message, data }`，业务 code 含 `FILE_TOO_LARGE` / `UNSUPPORTED_FORMAT` / `DOWNLOAD_FAILED` / `TASK_NOT_FOUND` 等。

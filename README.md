# 舞蹈老师 Web · v1.0.0

把本地舞蹈视频自动分析成按 8 拍划分的教学课，并提供慢放、数拍、镜像、学习进度和三种可靠循环。

v1 的权威产品与实现说明是 `docs/PRD/PRD-v1.0-complete.md`，发布验收记录是 `docs/releases/v1.0.0.md`。

## 最方便的本地启动方式

前置条件：安装 Docker Desktop。

1. 在 Finder 中双击 `start_local.command`。
2. 脚本会在需要时打开 Docker Desktop，构建并启动前后端。
3. 浏览器会自动打开 <http://localhost:8000>。

停止时双击 `stop_local.command`。停止不会删除视频、课程进度或 Docker 镜像；持久数据保存在 `backend/data/`。

也可以在终端运行：

```bash
./start_local.sh
```

如 8000 端口被占用：

```bash
DANCE_TEACHER_PORT=8010 ./start_local.sh
```

## 开发与测试

```bash
cd frontend
npm ci
npm test -- --run
npm run build
```

```bash
backend/.venv/bin/python -m pytest -q
```

生产形态验证：

```bash
docker compose up -d --build --wait --wait-timeout 300
curl http://localhost:8000/health
```

## v1 架构

- 前端：React 18、TypeScript、Vite、MUI、Zustand。
- 后端：FastAPI、ffmpeg、librosa、NumPy。
- 发布：一个多阶段 Docker 镜像；FastAPI 同端口提供 API、视频和 React SPA。
- 数据：服务端任务/视频/WAV 存在 `backend/data/`；浏览器学习状态存在 localStorage，较大的分析结果存在 IndexedDB。

## 文档入口

- `docs/PRD/PRD-v1.0-complete.md`：v1 唯一权威 PRD，含全部功能、实现和踩坑。
- `docs/releases/v1.0.0.md`：冻结范围、验收证据和已知限制。
- `docs/PRD/requirements-audit.md`：逐项防回归台账。
- `docs/system_design.md`：详细系统设计。
- `dance_teacher_prd.md`：最初规划稿，仅保留历史依据。

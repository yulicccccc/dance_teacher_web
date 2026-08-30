# 舞蹈老师 Web · v1.2.3

把本地舞蹈视频自动分析成按 8 拍划分的教学课，并提供慢放、数拍、镜像、学习进度、六档可靠循环，以及带拍数和口令的对照录制。

v1 的权威产品与实现说明是 `docs/PRD/PRD-v1.0-complete.md`，发布验收记录在 `docs/releases/`。

## 在线版

完整 Docker 版部署在 <https://dance-teacher-web.onrender.com>。免费实例闲置后会休眠，第一次打开可能需要约 50 秒唤醒；页面会自动等待，不需要操作终端。

## 最方便的本地启动方式

前置条件：安装 Docker Desktop。

最省事的入口是双击桌面的原生应用 `舞蹈老师.app`。它在后台自动完成全部启动步骤，不会弹出终端窗口。项目目录中仍保留 `打开舞蹈老师.command` 和 `start_local.command` 作为备用入口。

1. 双击 `舞蹈老师.app`。
2. 应用会在需要时打开 Docker Desktop 并等待就绪；优先使用本机已有版本快速恢复，只有镜像缺失或损坏时才自动重建。
3. 健康检查通过后，浏览器会自动打开 <http://localhost:8000>。
4. 成功时显示系统通知；失败时直接弹出最近的诊断信息。

平时不必停止，关闭网页即可。需要释放 Docker 资源时再双击 `stop_local.command`；停止不会删除视频、课程进度或 Docker 镜像，持久数据保存在 `backend/data/`。

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

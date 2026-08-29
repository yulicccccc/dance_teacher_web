# 舞蹈老师需求总台账

> 最后核对：2026-08-29
>
> 权威产品文档：`docs/PRD/PRD-v1.0-complete.md`。本文件作为逐项防回归台账，不替代完整 PRD。
> 用途：任何重构、回滚和部署都必须逐项检查，避免修一个问题时丢掉别的功能。

## 1. 需求源与优先级

1. `dance_teacher_prd.md`：产品总规划。文末明确“Phase 1（MVP）以 P0 需求为准”。
2. Git 历史 `6fe2fa9:docs/PRD/loop-redesign-prd.md`：循环 v2 的交互真相源；本次落实其全部 P0/P1。
3. Git 历史 `2dd1c36:docs/frontendize-prd.md` 与
   `6fe2fa9:docs/prd_browser_beat.md`：纯浏览器部署提案。其“保留全部交互”和
   BPM 精度要求继续有效；“零后端”是技术假设，已被真实 iPhone MOV 验证否决。
4. `docs/system_design.md`：FastAPI + React 的实现契约；2026-08-08 补记为
   Docker 单容器、同源生产部署。

发生冲突时，先守产品行为与真实准确度，再选择实现架构。不得为了静态免费部署
牺牲视频格式兼容、外链入口、BPM 精度或已有教学交互。

## 2. Phase 1 P0 功能核对

| PRD | 当前实现 | 验证入口 |
|---|---|---|
| P0-1 本地文件 + URL、进度、失败重试 | 本地/URL 均保留；大文件 4MB 分块、幂等上传、自动重试 | `Uploader`、`client.test.ts`、`uploader.test.tsx` |
| P0-2 librosa BPM + 8 拍分段 | 服务端 ffmpeg/librosa，与本地使用同一算法 | 后端 beat/segment 测试；真实 MOV 本地/线上同为 127.15 BPM |
| P0-3 四阶段分析进度与重试 | queued → extracting → beat_detecting → segmenting → done/failed | `AnalysisPage`、API retry 测试 |
| P0-4 小节列表、点击跳转、当前节高亮 | 保留；多节模式下该列表同时承担唯一勾选入口 | `SegmentList.multiSelect.test.tsx` |
| P0-5 播放器基础操作 + 变速/进度 | 单击播放/暂停；双击左/中/右=上一拍/全屏/下一拍；空格/K、←→、F；0.25x–1.5x 变速与时间轴拖动 | `VideoPlayer.test.tsx`、`ControlBar` |
| P0-6 分段循环 | 当前、前节、后节、单节、多节、AB 六档模式，共用一个“循环”总开关 | 循环测试组 |
| P0-7 1–8 数拍 + 脉冲 | rAF 驱动，节拍叠加层独立镜像 | `BeatOverlay.test.tsx`、beat sync 测试 |
| P0-8 镜像/视角 | 单机位视频镜像默认开；拍点镜像独立控制 | `ControlBar.loopButton.test.tsx`、`VideoPlayer.test.tsx` |
| P0-9 本地进度恢复 | localStorage + IndexedDB；循环 v2 状态纳入持久化 | `localProgress.test.ts` |
| P0-10 已学会标记 | 教学页标记、左栏状态、进度页汇总 | `lessonStore.test.ts`、Progress 页面测试 |

## 3. 循环 v2 + v1.1 精细练习档核对

| 范围 | 已落实行为 | 回归护栏 |
|---|---|---|
| P0-1~4 | 仅一个固定文案“循环”按钮；按钮只开关；当前/前节/后节/单节/多节/AB 六选一；多节空选置灰 | `ControlBar.loopButton.test.tsx` |
| P0-5~7 | 删除重复 `LoopPanel`；多节勾选只在左栏出现；其余五档不出现勾选框 | 全局 `LoopPanel` 搜索为空；`SegmentList.multiSelect.test.tsx` |
| P0-8~9 | 单节前后各一拍；点哪节自动开循环并强制锁到该节，避免旧目标回拉 | `beatSync.test.ts`、`useBeatSync.multi.test.tsx` |
| v1.1-1 | 当前动作循环=上一拍＋当前拍＋下一拍；真实 seek 重锁，自动 seek 不重锁 | `beatSync.test.ts`、`useBeatSync.multi.test.tsx` |
| v1.1-2 | 前节=上一节 8 至本节 5；后节=本节 4 至下一节 1；首尾截断 | `beatSync.test.ts`、`useBeatSync.multi.test.tsx` |
| v1.1-3 | 前节/后节/单节左栏秒数与实际引擎同源；上下文拍内切模式不串节 | `SegmentList.multiSelect.test.tsx`、`useBeatSync.multi.test.tsx` |
| P0-10 | 连续多节合并成一个块；非连续块按顺序轮转；块前后各一拍 | `useBeatSync.multi.test.tsx` |
| P0-11 | AB 拍点对齐；只有 AB 模式且总开关开启时驱动 AB 引擎 | `abLoop.test.tsx`、LessonPage 映射 |
| P0-12 | 单击画面播放/暂停；双击左/中/右三区=上一拍/全屏/下一拍，方向不受视频镜像影响 | `VideoPlayer.test.tsx`、`useBeatSync.step.test.tsx` |
| P0-13 | 新状态字段和旧 `loopSegment` / `abLoop.enabled` 存档迁移 | `localProgress.test.ts` |
| P0-14 | 切模式只改 store，不 seek、不暂停 | store 单元测试 + 引擎模式回归 |
| P1-1 | 状态摘要：关闭、当前三拍、前/后半节、单节、多节区间折叠、AB 端点 | `ControlBar` |
| P1-2~3 | 多节“全选/清空”；选择态与当前播放态分别显示 | `SegmentList`、store 测试 |
| P1-4~5 | AB 控件仅 AB 模式显示；无效 AB 禁用；多节清空自动关循环 | 控制栏与 store 测试 |
| P1-6 | 点文字跳转；点 checkbox 只勾选，两个热区互不串扰 | `SegmentList.multiSelect.test.tsx` |
| P1-7 | 六档循环模式、开关、选择、AB、次数均持久化 | `useLocalProgress` |

循环 v2 的 P2 属于原 PRD 明确列出的可选/非目标：Shift 连选和进度条循环块
仍记录在后续路线；其中基础播放器快捷键与“循环次数上限 UI”已经提前完成。

## 4. 已有增强能力（不得回归）

- 用户本人录制的本地 1–8 WAV 口令，可开关；同一音源同时输出到扬声器和对照录制混音总线。资产 manifest 锁定 8 段音频的格式、顺序与校验值。
- 低置信度提示、自动/固定 120/手动第一拍/手填 BPM 重算。
- 拍点偏移采用“草稿 → 重新计算拍子”两段式确认；确认后所有播放/循环功能读取同一新网格，首尾不足 8 拍的小节仍保留并覆盖完整视频时长。
- 我的课程、断点续学、已学小节、完成度百分比和累计练习时长统计。
- 摄像头左右对照、录制、下载；老师视频仍由同一个六档循环引擎驱动，开始录制不取消循环。对照 Canvas 写入左上拍数，老师原声+已开启口令混为单音轨；录制镜像写入文件，回看镜像独立。
- 内置示例、单击画面播放/暂停、双击三区逐拍/全屏、基础键盘操作、循环次数限制。

## 5. 已登记的后续阶段（不是本轮遗漏）

总 PRD 的 P1-2 前奏/间奏智能跳过、P1-3 拖动分段边界、P1-5 姿态识别原型，
以及 P2 的账户同步、社区分享、官方课程、细粒度 AI 纠错、移动 App，均属于总 PRD
明确标注的 Phase 2/远期路线。它们保留在总 PRD 和本台账中，不得在未来规划时丢失，
但不作为当前 Phase 1 发布的完成门槛。

## 6. 发布门槛

每次发布至少通过：前端 typecheck + 全量 Vitest、后端全量 pytest、Docker 构建，
并在正式 URL 用真实 MOV 验证上传、BPM/置信度、六档循环和手机端播放。

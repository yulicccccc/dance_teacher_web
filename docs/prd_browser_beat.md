# PRD：节拍检测浏览器端化 —— 纯静态零服务器改造

> 版本 v1.0 ｜ 作者：Alice（PM）｜ 状态：待架构评审

## 1. 项目信息

| 项 | 内容 |
|---|---|
| Language | 中文 |
| Programming Language | Vite + React + TypeScript + MUI + Tailwind CSS（保持现状，**移除 FastAPI/librosa 后端**） |
| Project Name | `dance_teacher_browser_beat` |
| 部署形态 | 纯静态站点（`frontend/dist` 直接托管到 CloudStudio），无服务器进程、无终端、无 `/api` 调用 |

### 原始需求复述

把节拍检测能力从后端（FastAPI + librosa + ffmpeg）**彻底迁移到浏览器端**，使整站成为纯静态前端。改造后部署到 CloudStudio 永久零服务器、零终端。**现有全部交互必须原样保留、行为不变。**

---

## 2. 产品定义

### 2.1 Product Goals

| # | 目标 | 可度量判据 |
|---|---|---|
| G1 | **零服务器**：全站构建产物为静态资源，运行期不发起任何后端请求 | 构建产物中不含 `/api/v1` 请求；断开后端后完整走通「上传 → 检测 → 练习」全流程 |
| G2 | **行为等价**：`AnalysisResult` 数据契约与全部现有交互零回归 | 现有 6 类交互（见 §3.1 P0-3）逐条回归通过；同一视频前后端检测 BPM 差 ≤ 容忍阈（见 §7 Q3） |
| G3 | **隐私 + 可离线**：视频不离开本机，首屏加载后无网可用 | 无 `multipart` 上传；DevTools Network 在检测阶段无外发请求 |

### 2.2 User Stories

| # | 故事 | 覆盖点 |
|---|---|---|
| US1 | 作为舞蹈学习者，我想**选择本机的舞蹈视频**并在浏览器里直接得到 8 拍分段，这样不用等服务器唤醒、不用上传等待 | 真实视频检测 |
| US2 | 作为在舞室/地铁练舞的用户，我想在**没有网络**（或服务器已下线）时打开站点仍能完成检测和练习，这样练习不被环境打断 | 离线 / 无服务器 |
| US3 | 作为对拍点敏感的用户，当自动检测的第一拍对不上老师起范时，我想**拖偏移滑块并点「重新计算拍子」**重切网格，这样 1-8 数拍能和音乐对齐 | 偏移修正 |
| US4 | 作为知道曲目 BPM 的用户，当自动检测明显失准时，我想**手动填入 BPM 重切**，这样不依赖算法也能拿到可用网格 | 手动 BPM 兜底 |
| US5 | 作为在磕细节的用户，我想对**单个小节循环**或**勾选多个小节做 AB 循环**，并独立开关**视频镜像 / 拍点镜像**，这样能反复抠动作 | 循环练习 + 双镜像 |

---

## 3. 需求池（Requirements Pool）

### 3.1 P0 — Must have（不做则改造不成立）

| ID | 需求 | 验收标准 |
|---|---|---|
| P0-1 | **浏览器内音频解码**：从用户选择的视频文件中取出单声道 PCM，采样率对齐分析需求（现后端为 22050 Hz） | mp4/mov/webm 均能拿到 `Float32Array` + `duration`，与后端 ffmpeg 抽出的时长误差 < 0.1s |
| P0-2 | **浏览器内节拍检测**：输出 `bpm` / `confidence` / `beatTimes[]` / `duration`，并按「每 8 拍一小节」切分为 `segments` | 输出对象结构与现有 `AnalysisResult`（§4）**字段级完全一致**，前端其余代码零改动即可消费 |
| P0-3 | **保留全部现有交互**，行为不变：<br>① 选择视频 → 检测 → 展示分段<br>② 偏移滑块 `draftBeatOffset` + 「重新计算拍子」<br>③ 单节循环 / 多节循环（AB 循环）<br>④ 视频镜像 / 拍点镜像（两个独立开关）<br>⑤ 左侧小节列表点击跳转 + 单节自动循环<br>⑥ 手动填 BPM 重切 | 6 项逐条回归；`resegmentSegments()`、`findBeatAt()`、`useBeatSync`、`lessonStore` **不得修改语义** |
| P0-4 | **`recompute` 四种模式本地等价实现**：`auto` / `fixed120` / `fixedBpm` / `manual_first_beat`（语义见 §4.3） | 四种模式的 `segments` 输出与后端同参数结果一致 |
| P0-5 | **8 拍切分规则 1:1 移植**（含尾段规则，见 §4.2） | 同一 `beatTimes` 输入，前端切分结果与后端 `segmenter.aggregate` 逐字段相等 |
| P0-6 | **视频播放源改为本地对象 URL**：`LessonPage` 现有 `videoSrc = ${apiClient.BASE}/video/${taskId}` 必须替换 | 播放、seek、`CompareMode` 对照模式均正常；无 `/api/v1/video/*` 请求 |
| P0-7 | **纯静态可部署**：移除 `backend` 运行依赖，`apiClient` 相关调用（`upload`/`getStatus`/`getResult`/`retry`/`recompute`/`health`/`warmup`）全部下线或改为本地实现 | `npm run build` 产物直接静态托管即可运行；首页不再出现「正在唤醒服务器…」 |

### 3.2 P1 — Should have（影响可用性，强烈建议同期做）

| ID | 需求 | 验收标准 |
|---|---|---|
| P1-1 | **格式兼容**：mp4 / mov / webm（沿用现有 `accept="video/mp4,video/webm,video/quicktime"`） | 三种格式各 1 个样本检测成功 |
| P1-2 | **时长 / 体积上限**：现后端为 ≤10 分钟、≤500MB；本次建议按浏览器算力收紧（见 §7 Q4） | 超限时给出明确中文提示，不进入检测 |
| P1-3 | **进度提示**：保留现有 `queued → extracting → beat_detecting → segmenting → done/failed` 状态机与百分比进度条（`AnalysisPage` 步骤条复用） | 检测中进度单调递增，UI 不出现「卡住不动」超过 3s 无反馈 |
| P1-4 | **失败 / 超时兜底**：解码失败、无音轨、检测异常、超时，均降级到「手动填 BPM」入口而非死路 | 任一失败路径都能一键进入「用 120 BPM 先切」或「填 BPM」，不需要刷新页面 |
| P1-5 | **低置信度提示**：保留 `beatLowConfidence`（`confidence < 0.6`）及其前端提示 | 低置信样本上提示正常出现 |

### 3.3 P2 — Nice to have

| ID | 需求 | 说明 |
|---|---|---|
| P2-1 | **Web Worker 不卡 UI**：解码 + 检测放入 Worker，主线程保持可交互 | 检测期间页面可滚动、可取消 |
| P2-2 | **大文件分块 / 流式解码**：避免整段视频一次性读入内存导致标签页崩溃 | 长视频（≥5 分钟）峰值内存可控 |
| P2-3 | **与现有 Demo 模式共存**：`buildDemoResult()` / 「试用示例」按钮保持可用 | Demo 模式仍走内置网格，不进检测流程 |
| P2-4 | **PCM 结果缓存**：缓存解码后的音频数据，使 `recompute(auto)` 无需用户重新选文件 | 「重新分析」可在不重选文件时执行 |
| P2-5 | **取消检测**：检测中可中止 | 点「取消」立即回到选择页 |

---

## 4. 数据契约（前端自算的 `AnalysisResult` Schema）

> 与 `frontend/src/types/api.ts`、`backend/app/schemas/analysis.py`、`frontend/src/demo/sampleLesson.ts#buildDemoResult` **完全对齐，不新增、不删除、不改名**。

### 4.1 结构定义

```ts
interface Segment {
  index: number      // 1-based，连续递增
  startTime: number  // 秒；= 本节第 1 拍时间戳
  endTime: number    // 秒；= 下一节第 1 拍时间戳（尾段见 4.2）
  type: string       // 固定 'dance'（'intro' | 'break' 为预留值）
  beats: number[]    // 本节各拍【绝对时间戳（秒）】，正常长度 8，尾段可 < 8
}

interface AnalysisResult {
  taskId: string             // 本地生成（如 crypto.randomUUID()）；Demo 模式固定 'demo'
  videoName: string          // = file.name
  bpm: number                // 保留 2 位小数
  confidence: number         // 0~1
  duration: number           // 秒（音频时长）
  createdAt: string          // ISO-8601，如 new Date().toISOString()
  segments: Segment[]
  beatLowConfidence?: boolean // = confidence < 0.6
}
```

### 4.2 切分规则（必须 1:1 移植 `segmenter.aggregate`）

```
每 8 拍一节，index 从 1 开始，type = 'dance'
segments[i].startTime = beatTimes[8i]
segments[i].beats     = beatTimes[8i : 8i+8]
segments[i].endTime   = beatTimes[8i+8]                       // 存在下一节时
尾段（剩余 < 8 拍，仍然发出，不得丢弃）：
  avg     = 尾段内相邻拍间隔平均值（不足 2 拍时取 0.5）
  endTime = min(duration, 尾段末拍 + 0.5 * avg)
```

> ⚠️ 「尾段不足 8 拍也必须发出」是后端已修复过的线上 Bug（曾导致「视频里 8 小节只显示 7 小节」），移植时必须保留。

### 4.3 `recompute` 四模式语义（必须 1:1 移植 `TaskManager.recompute`）

| mode | 输入 | 行为 | bpm / confidence |
|---|---|---|---|
| `auto` | — | 对已解码音频重跑检测 | 取检测结果 |
| `fixed120` | — | 生成 120 BPM 均匀网格 | `bpm=120`，`confidence=1.0` |
| `fixedBpm` | `bpm` ∈ [40, 300] | 生成该 BPM 均匀网格；越界报错「BPM 需在 40–300 之间」 | `bpm=入参`，`confidence=1.0` |
| `manual_first_beat` | `firstBeatTime` | 以该时刻为第 1 拍锚点，按当前 `bpm`（缺省 120）生成网格 | `bpm` 不变 |

均匀网格生成：`t = start; while (t <= duration) { beats.push(round(t, 4)); t += 60 / bpm }`
所有模式执行后统一 `beatLowConfidence = false`，`status = 'done'`，`progress = 100`。

### 4.4 必须守住的算法不变量

```
60 / median(diff(beatTimes)) ≈ bpm     // 报告的 BPM 必须描述真实发出的拍点
```

> 后端注释明确记录：曾经只改 BPM 数字不改拍点间距，导致「每个 8 拍跨越了错误的音乐长度」，34 个测试样本中 15 个中招。前端实现必须保持该不变量。

### 4.5 状态机（复用现有 `TaskStatus`，改由本地驱动）

| status | progress | 含义 |
|---|---|---|
| `queued` | 0 | 已选择文件 |
| `extracting` | 10 | 解码 / 抽音频中 |
| `beat_detecting` | 40 → 75 | 节拍检测中（可细分里程碑） |
| `segmenting` | 80 | 切分 8 拍小节 |
| `done` | 100 | 完成 |
| `failed` | 0 | 失败，`error` 带中文原因 |

---

## 5. UI 设计稿要点

### 5.1 复用（**不改动视觉与交互**）

| 页面 / 组件 | 处置 |
|---|---|
| `LessonPage` 及其全部子组件（`VideoPlayer` / `BeatOverlay` / `SegmentList` / `ControlBar` / `LoopPanel` / `BeatInfoCard` / `CompareMode`） | 完全复用，仅 `videoSrc` 数据源替换为本地对象 URL |
| `AnalysisPage` 步骤条 + 百分比进度 | 完全复用，数据源从「轮询后端」改为「订阅本地检测进度」 |
| `ProgressPage`「我的课程」 | 复用（但需解决 §7 Q2 的视频源恢复问题） |
| `lessonStore` 全部状态（含 `draftBeatOffset` 两段式提交语义） | 不动 |
| `resegmentSegments()` / `findBeatAt()` / `useBeatSync` | 不动 |
| 「试用示例」Demo 入口 | 保留 |

### 5.2 调整

| 位置 | 变更 |
|---|---|
| `UploadPage` | 移除「正在唤醒服务器…」提示与 `warmup()` 调用；文案从「上传你的舞蹈视频」改为「选择你的舞蹈视频」，强调「视频不上传、全程本地处理」 |
| `Uploader` | 文件选择保留；**「视频链接」输入框需决策去留**（见 §7 Q5）；限制文案随 §7 Q4 结论更新 |
| `AnalysisPage` | 步骤文案微调（「上传中」→「读取文件」，「服务器分析中」→「本地分析中」） |

### 5.3 新增

| 组件 | 说明 | 优先级 |
|---|---|---|
| 首次加载提示 | 若引入 wasm 依赖，需「正在加载分析引擎（约 N MB，仅首次）」提示 | P1 |
| 格式 / 时长不支持提示 | 明确告知原因与建议（如「该视频无音轨，请手动填写 BPM」） | P1 |
| 检测失败兜底面板 | 「自动检测失败」+ 两个按钮：「用 120 BPM 先切」/「手动填写 BPM」 | P1 |
| 取消检测按钮 | 检测中可中止 | P2 |
| 浏览器兼容性提示 | 不支持时给出建议浏览器 | P2 |

---

## 6. 验收标准（Definition of Done）

1. `backend/` 目录不再参与运行；`frontend/dist` 静态托管即可完整使用。
2. 用同一支真实舞蹈视频，改造前后 `segments` 数量一致，`bpm` 差异在约定容忍范围内（§7 Q3）。
3. §3.1 P0-3 的 6 项交互逐条人工回归通过。
4. 全流程 DevTools Network 面板无 `/api/v1/*` 请求。
5. 断网后刷新页面（Service Worker 缓存或直接二次访问）仍可完成一次完整检测（若采纳 P2 离线缓存）。

---

## 7. 待确认问题（Open Questions → 需架构师决策）

| # | 问题 | 背景 / PM 倾向 |
|---|---|---|
| **Q1** | **节拍检测方案选型**：`aubio.wasm` / `essentia.js` / `Meyda + 自研` / 其他？ | 后端 `beat_detector.py` 有 ~1400 行高度精调逻辑：onset 包络双 hop（256/128）、均匀网格最小二乘 + 两级梳状搜索、onset 吸附（±60ms）、八度纠正（F-measure 门控）、低频带真快速恢复、双路径 confidence。**全量复刻代价极高**。PM 建议分层移植：<br>**必做**：onset 包络 → 全局 tempo 估计 → 均匀 (period, phase) 拟合 → 8 拍切分<br>**可选**：低频带快速恢复、八度 F-measure 门控、raw+snap 回退路径<br>请架构师明确「移植到哪一层」并评估工作量 |
| **Q2** | **视频源持久化**：改用 `URL.createObjectURL(file)` 后，`ProgressPage`「我的课程」在刷新/重开浏览器后 blob URL 失效。是 ① 把视频 Blob 存 IndexedDB（体积大，可能数百 MB），还是 ② 提示用户「请重新选择同一个视频文件」（体验降级但零存储）？ | PM 倾向 ②（配合按 `name:size:lastModified` 生成的 `videoId` 校验是否同一文件），把「已学会小节」进度保住即可。这是**必须尽早定的架构点** |
| **Q3** | **准确度对齐与误差容忍**：浏览器端结果能否对齐 librosa？容忍多少？ | PM 建议验收口径：同一视频 **BPM 相对误差 ≤ 2%**（或落在同一八度且 ≤2%）、**第 1 拍时间偏差 ≤ 80ms**（MIREX 惯例 70ms + 少量宽裕）。若达不到，需把 §7 Q6 的手动兜底提到 P0 |
| **Q4** | **时长 / 体积上限**：现后端为 ≤10 分钟 / ≤500MB，team-lead 提出「5 分钟内」。最终取值？ | 取决于浏览器解码 + 检测耗时。PM 建议：**默认上限 5 分钟**，超过给「可能较慢」软警告而非硬拒绝；体积上限由内存实测决定 |
| **Q5** | **「视频链接」入口去留**：现有 `Uploader` 有 URL 输入框，后端会下载远程视频。纯前端受 CORS 限制，绝大多数外链无法 `fetch` | PM 倾向 **移除该入口**（或降级为「仅支持允许跨域的直链」并标注）。请架构师确认是否可接受这个功能删减 |
| **Q6** | **手动 BPM 是否作为「无检测」兜底**：即使检测方案失败/未接入，是否保证「手动填 BPM → 生成均匀网格 → 正常练习」始终可用？ | PM 明确要求 **是**。这条应视为最低可用保底路径，且是纯计算、零依赖，建议**先行落地**（可与 Q1 并行，作为风险对冲） |
| **Q7** | **`recompute(auto)` 的音频复用**：重跑检测需要已解码 PCM。是常驻内存、存 IndexedDB，还是要求用户重选文件？ | 关联 P2-4。PM 倾向「同一会话内常驻内存，跨会话要求重选」 |
| **Q8** | **wasm 体积与首屏**：若选 `essentia.js`（较大）或 `ffmpeg.wasm`（~25MB+），首屏成本是否可接受？CloudStudio 静态托管是否支持所需的 COOP/COEP 响应头（`SharedArrayBuffer` 前置条件）？ | **这是可能一票否决 ffmpeg.wasm 多线程版的硬约束**，请优先验证 |
| **Q9** | **音频抽取路径**：`ffmpeg.wasm` 解码 / `WebAudio decodeAudioData`（对 mp4 容器支持不一）/ `WebCodecs`（兼容性较新）/ 仅接受音频文件？ | PM 倾向优先试 **`WebAudio decodeAudioData` 直接吃视频文件 ArrayBuffer**（零额外依赖，Chrome/Safari 对 mp4-AAC 支持良好），失败再降级 `ffmpeg.wasm`。请架构师做兼容性摸底 |
| **Q10** | **对照模式（`CompareMode`）摄像头** 依赖 `getUserMedia`，要求 HTTPS。CloudStudio 部署是否为 HTTPS？ | 若非 HTTPS，该功能会静默失效，需提前确认 |

---

## 8. 风险提示（PM 视角）

| 风险 | 影响 | 缓解 |
|---|---|---|
| 浏览器端检测精度显著低于 librosa | 核心价值受损，用户觉得「拍子不准」 | 手动 BPM / 偏移修正提到 P0（Q6），先保底再提精度 |
| wasm 体积拖慢首屏 | 首次访问体验差 | 懒加载分析引擎（选择文件后再加载），加载中给明确提示 |
| 长视频导致标签页 OOM | 崩溃、数据丢失 | 时长上限 + Web Worker + 流式解码（P2-2） |
| 「我的课程」视频源断链 | 用户以为数据丢了 | 尽早定 Q2；无论选哪种都要有明确文案 |

# 实现方式与踩坑记录（Devlog）

> 配套文档：[主 PRD](./loop-redesign-prd.md)
> 用途：记录每个功能**怎么实现的**、**踩过哪些坑**、**为什么这么修**，供外部 AI（Codex）与后续维护者 review。
> 所有结论均基于已落地代码（`frontend/src/`），可直接对照源文件核实。

---

## 坑 #1：BPM 精准检测——放弃 aubiojs / aubio.wasm，改用 beat-detection

**目标**：在浏览器里对上传视频的音轨做精准 BPM 检测与拍点定位，用于把视频切成「8 拍 = 1 小节」。

**踩坑过程**

1. 首选方案是 **aubiojs**（aubio 的 WASM 移植），因为 aubio 的 tempo/onset 算法业界成熟。
2. 实测发现：npm 上的 `aubiojs` 包**只发布了 JS glue 代码，不打包 `.wasm` 二进制**。运行时它会去请求一个远端 demo wasm URL，该 URL 已 **404**。
3. 尝试自行编译 aubio → wasm：需要 **emscripten 工具链**，本地环境没有，且给一个「零后端、零终端」的项目引入 emscripten 构建链本身就违背项目定位。
4. **结论：放弃 wasm 路线。**

**最终方案**：改用 **`beat-detection`**（MIT，纯 JS，无二进制依赖）。

管线：

```
原始 PCM (Float32Array)
  → spectral-flux onset detection      （频谱通量求 onset 强度包络）
  → 自相关 + comb-filter tempo estimation（估计 BPM）
  → DP beat tracking                    （动态规划求全局最优拍点序列）
  → { bpm, confidence, beats: Float64Array }
```

调用形态：

```ts
detect(pcm, { fs, minBpm, maxBpm })
// → { bpm: number, confidence: number, beats: Float64Array }
```

**工程要点**

- 在 **WebWorker** 中运行（`frontend/src/workers/beat.worker.ts`），传入**原始 PCM**，避免主线程卡顿导致 UI 掉帧。
- 自带 **`grid-only` 兜底**（`frontend/src/audio/gridOnlyDetector.ts`）：当检测失败或置信度过低时，用固定 BPM 生成等距网格，**保证永远有一份可用的小节网格**，UI 不会出现「没有分段」的死状态。
- 低置信度时弹窗引导用户「自动重算 / 固定 120 BPM / 手动标第一拍」，另有 `BeatInfoCard` 支持手动输入 BPM 重算。

**验证**：node 端烟测，用 120 BPM 点击列车（click train）作为输入 → 输出 `bpm ≈ 123`、`confidence = 1.0`，落在可接受误差内。

**给 Codex 的注意事项**：不要「优化」回 aubiojs/aubio.wasm。这不是性能取舍问题，是**包不发 wasm + 无工具链**的硬阻断。

---

## 坑 #2：单节循环「卡在当前小节」——rAF tick 与 seeked 事件的竞态

**症状**：单节循环开启时，点击左侧小节列表想切到另一节，播放头**跳过去又被立刻拽回原来那一节**，看起来像「卡住了」。

**成因**

1. `goToSegment` 先 `seek(seg.startTime)`，浏览器异步执行，随后才派发 `seeked` 事件。
2. `useBeatSync` 的循环目标锁定 `loopTargetRef` 是在 `seeked` 监听器里重新锚定的。
3. 但 `requestAnimationFrame` 的 `tick` **可能在 `seeked` 之前先跑一帧**。这一帧里 `loopTargetRef` 还指向**旧小节**。
4. 旧小节的 padded `loopEnd`（含 +1 拍缓冲）很可能**落在新小节起点之后**。于是 tick 判定「播放头越过了旧目标的 loopEnd」→ 触发回跳 → 播放头被拉回旧小节。

**修复**：引入 `forceLoopTargetRef`（`MutableRefObject<number | null>`）

- `LessonPage.goToSegment` 在**执行 seek 之前**，把目标小节 index 写入 `forceLoopTargetRef.current`。
- `useBeatSync` 的 `tick` **在每帧最开头、任何循环判定之前**同步消费它：

```ts
if (forceLoopTargetRef && forceLoopTargetRef.current !== null) {
  if (loopModeRef.current === 'single') {
    loopTargetRef.current = forceLoopTargetRef.current
    loopIterationRef.current = 0   // 重新开始计数
  }
  forceLoopTargetRef.current = null  // 恰好消费一次，绝不重复应用
}
```

**关键约束**

- **只有 single 模式消费该 ref**。multi 模式的目标切换由 `onSeeked` 的 re-anchor 处理（它会找到包含新位置的 loop block 并把 cursor 挪过去），若 multi 也消费会与 block cursor 打架。
- ref 消费后**必须立即置 null**，否则会被后续帧重复应用，覆盖掉用户后来的合法操作。
- 写 ref 的时机**必须早于 seek**，晚于 seek 就失去了抢在竞态前面的意义。

**回归护栏**：`frontend/tests/qa_independent_singleLoopForceTarget.test.tsx`

---

## 坑 #3：「点哪节就循环哪节」的实现路径

**期望行为**：单节模式下，用户点左侧小节列表任意一节 → 播放头跳过去 + **自动开启循环** + 循环目标就是被点的那一节。

**实现**（`LessonPage.goToSegment`）：

```ts
if (loopMode === 'single') {
  setLoopSegment(true)              // 幂等；store 内会互斥清除 abLoop
  forceLoopTargetRef.current = index // 必须在 seek 之前（见坑 #2）
}
seek(seg.startTime)
play()
```

**要点**

- `setLoopSegment(true)` 是**幂等**的：已开启时再调无副作用。
- 该调用在 store 内**会互斥清除 `abLoop`**（旧设计的副作用；v2.0 改由映射层保证互斥，见主 PRD §6.3）。
- **multi 模式下点击只跳转**，不自动开启循环、不写 ref——因为多节模式的循环对象是「勾选集合」，点某一节不应改变集合。

**重设计后的迁移**：`setLoopSegment(true)` 应改为 `setLoopEnabled(true)`；`loopMode === 'single'` 的判断条件**保持不变**（P0-9 明确要求保留该行为）。

---

## 坑 #4：多选段落空选，引擎降级为单节循环

**现状行为**：`useBeatSync` 内，当 `loopMode === 'multi'` 且 `loopSegmentIds` 为空时，`buildLoopBlocks` 返回空数组，`multi` 判定为 false，**代码流落入单节循环分支**——即「循环播放头当前所在段」，而不是跳到某个勾选项的起点。

```ts
const multi = loopModeRef.current === 'multi' && loopTargetsRef.current.length > 0
if (multi) { /* 多块循环 */ } else { /* 单节循环（含空选降级） */ }
```

**为什么这是坑**：这个降级在引擎层是「优雅兜底」，但在 UI 层暴露给用户就是**行为与模式标签不符**——用户选了「多选段落」，实际跑的却是单节循环，这正是用户吐槽「按了会不会变单节」的根源之一。

**v2.0 的处理**：不删引擎里的降级分支（保留作为防御），但在 UI 层通过 **P0-4「多节未勾选时开关置灰」** 让这条路径**变得不可达**。映射层保证 `loopMode==='multi' && loopSegmentIds.length===0` 时 `isLooping === false`，引擎的 `loopSegment` 入参为 false，根本不进循环分支。

---

## 坑 #5：双击左/右半屏跳拍——镜像把方向弄反了

**症状**：默认 `mirror=true`（模拟舞蹈房镜面），此时双击画面**左半边跳到后一拍、右半边跳到前一拍**，与「左退右进」的浏览器直觉完全相反。

**成因**：`VideoPlayer.onDoubleClick` 原本会根据 `mirror` prop 反转方向判定——设计者以为「画面镜像了，所以左右也要跟着翻」。

**修复原则（重要）**：**镜像只翻转视频像素，不改变用户在屏幕空间的意图。**

用户看到的是一块屏幕，他点屏幕左边就是「往回」，这与画面内容是否被水平翻转**无关**。所以判定改为**纯屏幕坐标**，完全忽略 `mirror`：

```ts
onDoubleClick={(e) => {
  const el = e.currentTarget as HTMLElement
  const rect = el.getBoundingClientRect()
  const onRightHalf = e.clientX - rect.left > rect.width / 2
  stepBeat(onRightHalf ? 1 : -1)   // 右 = 后一拍，左 = 前一拍
}}
```

**另一个必须保留的细节**：`useBeatSync.stepBeat` **有意不设置 `seekingForLoopRef`**。

```ts
/**
 * Intentionally does NOT touch `seekingForLoopRef`: the resulting `seeked`
 * event is treated by `onSeeked` as a genuine user seek, which re-locks the
 * loop target onto the new beat's segment.
 */
```

理由：如果把跳拍标记成「循环引擎自己的程序性 seek」，`onSeeked` 就不会重新锚定循环目标，下一帧循环引擎会**立刻把播放头拽回原循环区间**——跳拍等于没跳。让它被当作「真实用户 seek」，行为才与拖动进度条一致。

**回归护栏**：`frontend/tests/useBeatSync.step.test.tsx`、`frontend/tests/VideoPlayer.dotJump.test.tsx`、`frontend/tests/mirrorSplit.test.tsx`

---

## 坑 #6：循环按钮文案写死「单节循环」（本次二次修复）

**症状**：控制栏主循环按钮文案硬编码为「单节循环」。用户在 `LoopPanel` 里选了「多选段落」后，按钮**仍然显示「单节循环」**——用户不知道该不该按、按下去会不会退回单节。

**第一次修复（已落地，临时方案）**：让文案与 tooltip 随 `loopMode` + `loopSegmentIds` 动态变化。

| 状态 | 按钮文案 | tooltip |
|---|---|---|
| `single` | 「单节循环」 | 单节循环（含前后各一拍过渡，衔接更顺） |
| `multi` 且已勾选 N 段 | 「多选循环 (N)」 | 多选段落循环（已选 N 段，连续段自动合并） |
| `multi` 且未勾选 | 「多选循环」+ **disabled** | 多选模式下请先勾选要循环的段落 |

**为什么还要二次修复**：文案对了，但**结构没对**。用户的真实困惑是「一个按钮同时承担了开关与形态两个语义」。只要按钮还会改名，用户就会怀疑「按它是不是也会改模式」。

**v2.0 的结构性修复**：按钮文案**恒为「循环」**，只表达开/关；形态交给旁边独立的三选一控件。语义正交后，「按了会不会变单节」这个疑问从根上消失。

---

## 坑 #7：AB 循环与单节循环的互斥（store 副作用）

**现状实现**（`lessonStore.ts`）：互斥靠 setter 的副作用维持。

```ts
// 开启单节循环 → 清除 AB
setLoopSegment: (b) =>
  set(b ? { loopSegment: true, abLoop: null } : { loopSegment: false }),

// 启用 AB → 关闭单节循环
setABLoop: (v) =>
  set(v && v.enabled ? { abLoop: v, loopSegment: false } : { abLoop: v }),
```

**语义细节（容易看漏）**：只有「**启用** AB」（`v.enabled === true`）才会清除单节循环。**仅配置 A/B 点、或停用 AB，都不会动单节循环**——这是有意为之，用户可以在单节循环跑着的时候先把 A、B 点标好，再决定要不要切过去。

**为什么互斥是必须的**：两种循环的锚点体系不同——AB 锚在**拍点**上，单节锚在**乐句边界**上。同时开启会有两套逻辑争抢 `video.currentTime`，产生不可预测的抖动。引擎内部也用 `abLoop.enabled` 做了优先级保护（AB 分支优先，单节分支被 `else if` 跳过）。

**v2.0 的改进**：互斥从「setter 副作用」上升为「**类型层面的互斥**」——`loopMode` 是三选一枚举，天然不可能同时为 `'single'` 和 `'ab'`。映射层（主 PRD §6.3）再把它翻译成引擎认识的两个布尔量。这比副作用更难写错。

---

## 坑 #8：节拍偏移的「草稿 / 确认」双值设计

**问题**：用户拖动偏移滑条时，如果每拖一格就重切网格，正在跑的循环会不断被重锚，画面疯狂跳动，根本没法校准。

**方案**：拆成两个值。

| 字段 | 角色 | 谁在改 | 影响 |
|---|---|---|---|
| `draftBeatOffset` | 草稿值 | 滑条拖动 | **只影响拍点计数显示**的实时预览 |
| `beatOffset` | 已应用值 | 点「重新计算拍子」 | 重切 `offsetSegments` 网格 |

**实现细节**

- `offsetSegments = useMemo(() => resegmentSegments(segments, beatOffset), [segments, beatOffset])` —— 只认**已应用值**。
- 传给 `useBeatSync` 的偏移参数是**差值** `draftBeatOffset - beatOffset`。拖动时差值非零，数拍显示实时平移预览；但 `offsetSegments` **数组引用不变** → `useBeatSync` 的 effect（deps 为 `[segments, videoRef]`）不重跑 → **循环锁定不被打断**。
- 点「重新计算拍子」后 `setBeatOffset(n)` 同时把 draft 同步为 n（差值归零），`offsetSegments` 得到**新数组引用** → effect 重跑 → 在新网格下把循环目标重锚到播放头当前所在节：

```ts
if (loopRef.current && video) {
  const loc = locateBeat(segments, video.currentTime, video.currentTime)
  loopTargetRef.current = loc.activeSegment || null
  loopIterationRef.current = 0
}
```

**为什么重锚是必要的**：网格重切后，原来存的「第 5 节」这个编号对应的时间区间**已经完全变了**，继续用旧编号会让循环跳到一个被挪走的时间点。

**回归护栏**：`frontend/tests/qa_independent_offsetConfirm.test.tsx`、`qa_independent_resegment.test.ts`

---

## 坑 #9：对照练习模式下必须让循环引擎「停手」

**背景**：对照练习是**原地左右分屏**，不是弹窗。`VideoPlayer` 始终保持挂载（对照时仅 `display:none`），这样 `videoRef` 指向的 `<video>` 元素不会被卸载重建——播放进度、倍速、所有事件监听器全部原样保留。`CompareMode` 只是把这个元素画进 canvas 左半边。

**坑**：同一个 `<video>` 还在播，如果循环引擎继续发 seek + play，就会**和分屏播放抢播放头**。

**修复**：`useBeatSync` 增加 `active` 入参（`LessonPage` 传 `!compareOpen`）。`active === false` 时 tick 只更新 `prevTimeRef`（保持时间基准新鲜，避免重新激活时冒出幽灵 pulse），**不发任何 seek / play**：

```ts
if (!activeRef.current) {
  prevTimeRef.current = cur
  rafRef.current = requestAnimationFrame(tick)
  return   // rAF 链继续，但不做任何循环动作
}
```

注意 rAF 链**必须继续调度**，否则退出对照模式后循环引擎就死了。

---

## 坑 #10：测试 flaky——compareMode elapsed badge

**现象**：完整并行 suite 下，`frontend/tests/compareMode.test.tsx` 中「录制中 elapsed badge」的计时器断言**偶发失败**。

**诊断**：并行执行时 CPU 争用导致 fake/real timer 推进节奏抖动，断言的时间窗口太紧。**隔离运行（单独跑该文件）稳定通过**。

**结论**：这是**测试环境噪声，不是功能回归**。

**给 Codex 的提示**：如果 CI 上看到这条失败，先隔离重跑确认，不要据此判定循环重构引入了回归。若要根治，应放宽该断言的时间容差或改用确定性时钟，而不是改动 `CompareMode` 的实现。

---

## 附：状态字段迁移对照（快速索引）

| 旧 | 新 | 等价关系 |
|---|---|---|
| `loopSegment: boolean` | `loopEnabled: boolean` + `loopMode` | `loopSegment === (loopEnabled && loopMode === 'single')` |
| `loopMode: 'single' \| 'multi'` | `loopMode: 'single' \| 'multi' \| 'ab'` | 值域扩展 |
| `abLoop.enabled: boolean` | `loopEnabled && loopMode === 'ab'` | 运行态由组合决定；`enabled` 降级为「已配置」标记 |
| `loopSegmentIds: number[]` | 不变 | 选择入口从 `LoopPanel` 迁到 `SegmentList` |

**旧 `loopSegment` 为什么是坏设计**：一个布尔量同时编码了「是否循环」和「循环形态是单节」两件正交的事。这导致 UI 上必须用一个按钮同时表达两个语义，进而产生「选了多选模式按钮还叫单节循环」的困惑。v2.0 把它拆成 `loopEnabled`（开关）+ `loopMode`（形态），是本次重设计的根本动作。

---

## 核心不变量清单（Codex Review 请逐条核对）

1. `useBeatSync.ts` **零改动**。所有 UI/store 变更通过 `LessonPage` 的映射层吸收。
2. 单节循环含前后各一拍 padding（`computePaddedLoopBounds`）——行为不变。
3. 多节连续合并 + 前后各一拍、非连续分块顺序轮转（`buildLoopBlocks` / `computePaddedLoopBoundsForBlock`）——行为不变。
4. AB 拍点对齐、与单节互斥——行为不变（互斥实现方式从 setter 副作用改为枚举 + 映射层）。
5. 双击左/右半屏 = 前/后一拍，忽略 `mirror`——行为不变。
6. `forceLoopTargetRef` 仅 single 模式消费，且写入时机早于 seek——不变。
7. `stepBeat` 不设 `seekingForLoopRef`——不变。
8. 对照模式下 `active=false`，引擎不发 seek/play 但 rAF 链不断——不变。



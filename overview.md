# 交付概览 — BPM 半速修复 + 手动填 BPM + Part 2 五项交付

## TL;DR
修复快歌 220/240 BPM 半速检测、新增手动填 BPM 重算，并完成用户追加的 5 项功能/回归（多选段落循环、双击左右分拍、AB 循环加固、数拍镜面、圆点跳八拍）。两轮 QA 全绿放行。

## 交付状态
- 前端门禁：`tsc --noEmit` 0 错误；`vitest run` **180/180** 通过
- 后端门禁：`pytest` **95/95** 通过（BPM 修复 + fixedBpm 无回归）
- QA 路由判定：**NoOne**（源码与描述一致，无遗留源码缺陷）
- 已知问题：1（非阻塞 backlog — multi-loop + loopCount 组合路径缺显式用例）

## 提交清单（main）
| 提交 | 内容 | 范围 |
|------|------|------|
| `e7f32c2` | 修快歌 220/240 半速（RECOVER_CEIL_BPM=260 解耦）+ fixedBpm 重算模式 | 后端 |
| `b82f5ac` | 常驻节拍信息卡片 + 手动填 BPM 重算(fixedBpm) | 前端+后端 |
| `9fb4a63` | store 多选段落循环 loopMode/loopSegmentIds | 前端 store |
| `24b30b6` | 修 Part2 引入的 loopCount 限制回归（程序化 loop-back 正确短路） | useBeatSync |
| `43f3084` | 多选段落循环 + 双击左右分拍 + AB 循环加固 + 数拍镜面/点跳 | 多文件 |
| `db0579c` | 修点圆点跳八拍 off-by-one 与首点无响应 | LessonPage/VideoPlayer |

## 用户 5 项需求对照
1. ✅ 小节循环循环不到想要的小节 → LoopPanel 勾选段 + 单/多循环模式
2. ✅ 双击左定格上一拍、右定格下一拍 → onDoubleClick 按 mirror 翻转判定左右 + stepBeat(∓1)
3. ✅ AB 循环应用坏 → AB re-arm 加 active 守卫，对照模式不抢播放头
4. ✅ 数拍开启镜面 → BeatOverlay mirror(scaleX(-1)) + VideoPlayer 透传
5. ✅ 点圆点跳对应八拍 → onDotClick(0-based) + goToSegment(i+1) + total=真实段数

## 下一步建议
1. 启动后端：`backend/.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000`（沙箱常驻进程会被回收，打不开再说一声我重拉）
2. 启动前端：`cd frontend && npm run dev`，访问 http://localhost:5173
3. 手动填 BPM：在播放页常驻节拍卡输入正确 BPM 触发重算
4. 多选段落循环：控制栏 LoopPanel 勾选要循环的小节
5. backlog：后续补 multi-loop + loopCount 组合路径显式用例

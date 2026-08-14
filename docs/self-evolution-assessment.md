# 自进化系统评估记忆（2026-08-13）

> 本文档是 Kami 本地化工作台"学习中心 / 翻译技能进化循环"的评估快照与后续工作备忘录。
> 由 AI 代码审查生成，用于记录当前版本的已知缺陷、架构事实和修复路线，避免未来迭代重复踩坑。

## 1. 本次审查范围

- 服务端：`server.mjs`（学习中心 API、轨迹采集、评测执行）
- 学习引擎：`src/learning-engine.mjs`、`src/learning-benchmark.mjs`、`src/evolution.mjs`
- 模型层：`src/provider.mjs`（提案 / 翻译 / AIQA / 评测全部提示词）
- 存储层：`src/store.mjs`、`src/directus-store.mjs`（JSON 与 Directus 双后端）
- 前端：`public/app.js` 学习中心交互流
- 实测：单元测试套件 + 运行中实例的 API 状态

## 2. 当前版本状态

| 项目 | 状态 |
| --- | --- |
| 单元测试 | 101 通过 / 0 失败 / 7 跳过（跳过项为 Directus 与真实服务集成测试） |
| 运行中实例数据 | 每个作用域仅 1 个默认 champion 技能；0 条轨迹、0 个候选、0 次评测 |
| 配置模型 | `deepseek-v4-pro`（README 仍写本地 `qwen3:14b`，文档已过时） |
| 存储模式 | `directus/.env` 中 `KAMI_STORE=directus`，Directus + PostgreSQL 已在本机运行 |

## 3. 架构事实（可信赖的部分）

1. **四维作用域隔离**：`locale × contentType × domain × project` 强制隔离，拒绝通配值（`learning-engine.mjs`）。
2. **训练/评测数据隔离**：候选 `evidenceIds` 记录全部训练轨迹，留出集严格排除训练证据。
3. **晋升门禁**：强制术语回退、硬错误增加一票否决；质量门禁 + 成本/延迟护栏 + "至少一项实质收益"。
4. **人工闸门与版本链**：候选只能基于当前 champion 激活；评测后重新校验过期基线；支持回滚。
5. **降级路径**：模型不可用回退本地规则；JSON/Directus 双后端；DPAPI 加密 LLM Key。

## 4. 已知缺陷（按严重度排序）

### 4.1 致命：评测留出集被"标准答案"污染（gold leakage）

- 生产翻译 QA 通过后自动写入记忆库（`server.mjs` `runAiQaLoop`），人工采纳写入 human_approved 记忆与风格证据。
- 评测 `benchmarkTranslationSkill` 从**生产环境**记忆库、QA 案例、风格规范、译者画像检索上下文。
- `rankTranslationMemories` 对原文完全相同的记忆返回最高相似度 → 留出样本自己的终稿被作为参考译例注入 champion 与 challenger 双方上下文。
- 风格规范（阈值 8 条）与译者画像（阈值 3 条）同样由同批人工终稿蒸馏而来，再次泄漏。
- **后果**：双方译文趋向复制金标准 → 编辑距离≈0、QA 分≈满分、术语全对 → 增量指标坍缩为零 → "实质收益"门禁永不满足 → **进化循环实际冻结**（安全但惰性）。

### 4.2 闭环自我评分

提案者 = 译者 = AIQA 审校 = 评测者均为同一模型。QA 分门禁与"人工接受率"门禁本质是模型自评；客观信号只剩硬术语检查与编辑距离，而编辑距离已被 4.1 的泄漏毁掉。

### 4.3 非自主触发

生成候选、运行评测、批准启用全部为手动按钮，代码库中不存在任何调度器。当前形态是"人在环中的辅助进化"，不是自动迭代。

### 4.4 冷启动稀疏

需要同一四维作用域下 ≥20 条人工批准且排除训练证据的留出终稿。4 语言 × 9 语体 × 4 领域 × N 项目的组合空间中，绝大多数作用域永远攒不够。

### 4.5 评测成本无上限、无进度、无预算

- 一次评测最多约 240 次模型调用（60 对 × 2 变体 × 翻译 + AIQA），全部挤在一个阻塞 HTTP 请求中。
- 无进度轮询、无断点续跑、无预算上限；刷新页面或重启进程即丢失。
- `benchmarkTranslationSkill` 中 `cost: 0` 写死 → 成本门禁恒通过且永远无法成为收益项（真空门禁）。

### 4.6 策略补丁无 schema 校验

模型可向 `strategyPatch` 塞任意字段与垃圾值，读取时靠 `Number() || 默认值` 兜底；`additionalRules` 未经净化即注入后续提示词，轨迹中的恶意文本可间接 prompt-inject 进未来生产提示词。

### 4.7 指标口径不一致

评测 `requiredTermHits` 用 `String.includes()` 判断（存在子串误判），生产轨迹用 QA issue 去重统计——同一指标名两套算法。

### 4.8 合成"人工接受率"

评测用 `editDistance ≤ 0.12 && score ≥ 90` 冒充人工投票（UI 有诚实标注，但门禁仍依赖它）。

## 5. 本地部署缺陷

1. **Directus 启动即崩**：`initializeDirectusStore()` 在顶层 `await`，Docker 未启动时 health check 直接抛错，整个服务起不来。README 声称"学习存储不可用不阻断翻译"仅对运行中失败成立。退回 JSON 模式需手动改环境变量，且两种模式数据互不相通。
2. **资源争抢**：评测运行期间本地 Ollama 单模型排队，正常翻译被拖慢；云端模型则烧钱无上限。
3. **评测期间生产数据并发污染**：评测读活的生产记忆库，用户此刻的正常翻译同时在写。
4. **安全边界**：绑定 `127.0.0.1`、无鉴权、无限流；若为局域网协作改绑 `0.0.0.0`，API Key 与 Directus token 将直接暴露。
5. **密钥管理**：`.env` 中 Directus 管理员密码与 Service Token 明文（已 gitignore）；DPAPI 仅保护 LLM Key。
6. **文档漂移**：README 默认模型描述与实际配置（DeepSeek + 豆包 embedding）不一致；跨模型版本评测指标不可比，无基线重建机制。

## 6. 修复路线（按优先级）

1. ✅ **Clean-room 评测**（2026-08-13 已实施主体）：新增 `src/benchmark-isolation.mjs`，评测重跑前剔除与留出原文同源（归一化相等或相似度 ≥0.95）的翻译记忆、QA 案例，以及风格规范/译者画像中同源的正反例；每次评测报告携带 `benchmark.isolation` 剔除统计。剩余子项："零检索基线"对照尚未实现，画像/风格的指令文本中可能残留的抽象偏好（无法逐 case 消除）仍待观察。
2. ✅ **评测后台化**（2026-08-13 已实施）：新增 `src/evaluation-jobs.mjs` 后台任务队列（单任务串行、FIFO），评测转入后台执行，前端轮询 `/api/learning/evaluation-jobs/:id` 显示逐对进度，任务检查点逐对持久化到 `data/learning/jobs/`（已 gitignore），服务重启后任务标记为 `interrupted` 并可续跑剩余样本。真实成本：`provider.mjs` 的 `chat` 采集 OpenAI 与 Ollama 两种 usage 格式，模型设置新增输入/输出百万 token 定价，`src/skill-benchmark.mjs` 逐 case 记录 `usage` 与 `costUsd`；定价齐全时评测自动启用成本门禁（`requireCost`），否则跳过。剩余子项：生产翻译轨迹的 `costUsd` 记录（Directus 需加字段）与任务取消功能尚未实现。
3. ✅ **自动触发候选生成**（2026-08-13 已实施）：新增 `src/auto-proposal.mjs`（触发决策纯函数 + 串行化后台提议器）与 `src/skill-proposal.mjs`（手动/自动共用同一候选生成实现，顺带修复手动入口丢弃 champion metadata 的问题）。人工采纳或 QA 批准后触发后台检查：同一作用域人工批准终稿达到阈值（默认 10，`KAMI_AUTO_PROPOSE_THRESHOLD`）且无活跃候选时自动提议 challenger；上次成功后需再新增 10 条（`KAMI_AUTO_PROPOSE_GROWTH_WINDOW`）防抖，上次失败则任一新增终稿即重试。记账存于 champion 的 `metadata.autoPropose`，学习中心展示触发状态。评测与激活仍为人工闸门。剩余子项：Directus `translation_skills.metadata` 字段需在 Docker 恢复后执行 `npm run directus:provision`（脚本已更新，未运行时记账自动降级为不持久化）。
4. ✅ **策略补丁 Schema 白名单校验与净化**（2026-08-14 已实施）：新增 `src/strategy-patch.mjs`，候选生成前对模型返回的 `strategyPatch` 做白名单校验：未知区块/字段丢弃、数值按区间夹紧、布尔与类型强制、`additionalRules` 截断到 12 条 × 300 字符并剥离控制字符、`additionalInstruction` 截断到 600 字符；内置中英文注入特征拦截（"忽略以上规则"、"ignore all previous instructions"、"system:" 等），命中即整条丢弃。净化明细写入候选 `metadata.sanitization`，学习中心候选卡片展示。被丢弃字段回落冠军原值，净化后为空的补丁整体拒绝（409）。15 项新测试覆盖全部路径。
5. **启动容错**：Directus 不可用自动回退 JSON 模式并在界面告警，不让 `npm start` 崩溃。

## 7. 施工日志

| 日期 | 条目 | 内容 | 状态 |
| --- | --- | --- | --- |
| 2026-08-13 | 1 | Clean-room 评测隔离（`src/benchmark-isolation.mjs` + `server.mjs` 评测路径接入 + 8 项单元测试） | 已实施并提交（`b87de5a`） |
| 2026-08-13 | 2 | 评测后台化 + 真实 token 成本（`src/evaluation-jobs.mjs`、`src/skill-benchmark.mjs`、provider usage 采集与定价、前端轮询、5 项新测试） | 已实施并提交（`f27396f`） |
| 2026-08-13 | 3 | 自动触发候选生成（`src/auto-proposal.mjs`、`src/skill-proposal.mjs`、Directus metadata 字段、前端状态展示、12 项新测试） | 已实施并提交（`89caa9a`） |
| 2026-08-14 | 4 | 策略补丁白名单校验与净化（`src/strategy-patch.mjs` + 注入拦截 + 前端净化明细 + 15 项新测试） | 已实施，待提交 |

## 8. 结论

当前版本是"正确性优先、设计诚实、但进化被泄漏数据钉死"的保守系统，实际效果等于"带审计的固定提示词 + 检索增强"。要真正实现自进化，必须先解决 4.1（clean-room 评测），否则所有后续改进都无法被评测系统认可。

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

1. ✅ **Directus 启动即崩**（已修复）：启动时 Directus health check 失败会自动回退本地 JSON 存储，控制台打印告警、`/api/health` 与界面横幅可见；Directus 恢复后重启服务自动回归资产后台模式。注意回退期间的写入保存在 `data/` 下，不会自动同步回 Directus。
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
5. ✅ **启动容错**（2026-08-14 已实施）：`store.mjs` 的 `initializeStore` 在 `KAMI_STORE=directus` 且 Directus 不可用（health check 失败或缺少 token）时自动回退本地 JSON 存储，不再让 `npm start` 崩溃；回退状态（原因 + 时间）通过 `getStoreFallbackInfo()` 进入 `/api/health` 与 `/api/bootstrap`，前端顶部显示醒目横幅告警。回退仅在进程内生效，Directus 恢复后重启服务即自动回到资产后台模式。注意：回退期间的写入保存在 `data/` 下，不会自动同步回 Directus（数据分叉风险已在横幅中明示）。2 项单测 + 真实 env 冒烟验证。

## 7. 施工日志

| 日期 | 条目 | 内容 | 状态 |
| --- | --- | --- | --- |
| 2026-08-13 | 1 | Clean-room 评测隔离（`src/benchmark-isolation.mjs` + `server.mjs` 评测路径接入 + 8 项单元测试） | 已实施并提交（`b87de5a`） |
| 2026-08-13 | 2 | 评测后台化 + 真实 token 成本（`src/evaluation-jobs.mjs`、`src/skill-benchmark.mjs`、provider usage 采集与定价、前端轮询、5 项新测试） | 已实施并提交（`f27396f`） |
| 2026-08-13 | 3 | 自动触发候选生成（`src/auto-proposal.mjs`、`src/skill-proposal.mjs`、Directus metadata 字段、前端状态展示、12 项新测试） | 已实施并提交（`89caa9a`） |
| 2026-08-14 | 4 | 策略补丁白名单校验与净化（`src/strategy-patch.mjs` + 注入拦截 + 前端净化明细 + 15 项新测试） | 已实施并提交（`e4949fb`） |
| 2026-08-14 | 5 | 启动容错：Directus 不可用自动回退 JSON（`store.mjs` 回退 + health/bootstrap 告警 + 前端横幅 + 2 项测试与冒烟验证） | 已实施并提交（`54b7d55`） |
| 2026-08-14 | 6 | 超时错误修复：`fetchWithTimeout` 全生命周期超时转换（含正文读取阶段），模型/Directus 请求超时显示带标签中文错误并在模型调用上自动重试一次，服务端错误日志带时间戳；5 项新测试（`tests/provider-timeout.test.mjs`） | 已实施并提交（`00d1f88`） |
| 2026-08-14 | 7 | 翻译质量改进（韵文通道）：本地化优先提示词规则、`detectRhymeLike` 韵律结构检测（3+3+7/4+4+7/三连重复）注入 Context Pack、韵文专用再创作通道（高温度 + 示范样例）、AIQA 与修订提示词增加韵律/翻译腔维度、提示词版本升 v2；4 项新测试。**实测定论**：当前模型（中转站 `A-fzl-claude-sonnet-4-6`）即使在专用通道下仍输出字对字直译，模型能力是当前质量瓶颈；该中转站账号组仅此一个可用模型（其余全部 `model_not_found`），建议更换服务商，韵文通道在强模型上会自动生效 | 已实施并提交（`e8d498e`） |
| 2026-08-14 | 8 | 批次排比一致性（同批上下文锚定）：新增 `src/batch-verse.mjs`（`verseShape` 短句+长句句式识别、`detectBatchVerse` 严格过半数的批次排比检测、`normalizeBatchReferences` 锚点清洗），服务端按 batchId 自动检测排比模板，客户端顺序翻译时携带本批已定稿译文（最多 3 条）作为风格锚点，提示词/AIQA/自检增加同批句式一致性要求，排比批次走高温度初译；4 项新测试。解决了"同一批诗句各行格式不一致"的问题 | 已实施并提交（`214917c`） |
| 2026-08-14 | 9 | 创译重构（根治直译倾向）：提示词从"译者+严格"重构为"本地化写手+信息保真"框架（"换一种地道表达不等于漏译增译"），`config.mjs` 增加日/韩/繁中三语直译 vs 地道示范对（注入提示词），普通文本温度 0.25→0.6，AIQA 明确"地道改写不算问题、翻译腔记 major"，修订环节禁止退回直译，提示词版本升 v3。**实测**（DeepSeek 官方 deepseek-v4-pro）：肝就完了→根性で乗り切れ！、这波稳了→この流れはもらったな。、皮肤上线→新登場の限定スキンが只今配信中！——口语/营销类创译显著改善；"走走走"韵文仍为直译，属该模型韵文创作能力的硬上限，建议人工采纳或更强模型 | 已实施，待提交 |
| 2026-08-25 | 10 | 风格蒸馏去重与防抖（`src/style-distill-gate.mjs`）：修复分享反馈采纳时 `distillStyleProfileIfReady` 之后又调一次 `saveStyleProfile` 导致每次采纳生成两个重复草稿的 bug（`saveStyleProfile` 每次都新建记录，不是 upsert）；蒸馏前新增闸门——同作用域存在待审草稿则不蒸馏，上次蒸馏后证据池须再新增满增长窗口（默认 8，`KAMI_STYLE_DISTILL_THRESHOLD` / `KAMI_STYLE_DISTILL_GROWTH_WINDOW`）；`runEvolutionReview` 的 stylePatch 分支原先绕过所有阈值、每个完成批次都落一版草稿，现已并入同一闸门；`listStyleProfiles` 增加作用域过滤参数，避免 Directus 50 行分页把年轻作用域的草稿挤掉导致误判「无待审草稿」；前端按跳过原因区分展示进度（阈值 / 待审草稿 / 增量不足）。16 项新测试 | 已实施，待提交 |
| 2026-08-25 | 11 | 改动式风格学习与反例入池（`src/style-delta.mjs`）：风格证据新增 `machineTranslation` / `polarity` / `note` 三字段，人工采纳时从**轨迹**（而非客户端提交）取回被替换的机器初稿，蒸馏改为按 `revised`（有改动，携带 machineDraft）/ `confirmed`（原样采纳）/ `imported`（外部导入）三类排序取样，改写证据优先占用样本额度；风格与画像两个蒸馏提示词都改写为"读 diff 归纳规则"。**修复一处实际 bug**：同事在分享页只提问题、未给改写译法时，`server.mjs` 把被否决的当前译文当作正例写进风格证据池，等于教模型复制同事刚刚否掉的写法——现改为按反例入库并保留否决理由，判定逻辑提取为 `buildAdoptedStyleEvidence` 便于测试。译者画像与 Auto QA 参考证据统一经 `positiveEvidenceOnly` 过滤，反例不会被当成标准答案。20 项新测试 | 已实施，待提交 |
| 2026-08-25 | 12 | 风格草稿配对评测（`src/style-benchmark.mjs`）：`style_profiles` 首次进入晋升门禁。`benchmarkTranslationSkill` 增加 `styleProfileOverride` 与 `qaStyleProfile` 两个入口，使风格规范成为配对评测中的自变量；**AIQA 两侧一律使用当前生效版本打分**，否则草稿会用自己的尺子给自己判卷，`qa_score` 门禁将自我实现。`learning-engine` 新增 `guardrails.materialGainMetrics` 白名单，风格评测只认 `humanEditDistance` / `mandatoryTerms` / `hardErrors` 作为晋升理由（QA 分与合成接受率降为纯回归护栏），编辑距离最小收益提高到 0.01。`evaluation-jobs` 参数化 `kind` 与 `guardrails`，同一队列可承载两类评测且互不抢检查点；`deps.getSkill` 增加 scope 参数（风格规范按作用域寻址）。留出集在技能规则之上再排除蒸馏用过的原文——`isSelfDerived` 的 0.95 阈值对短句欠捕获（10 字句加一个句号只有 0.909），故额外用去标点同形做兜底。新增 `POST /api/style-profiles/:id/evaluate`、评测任务轮询接口与 `findStyleProfile` 存储原语；激活在评测结论反对时返回 409，强行启用记 `activationBasis: forced`，未评测记 `unevaluated`。19 项新测试（含 mock 模型下的中立裁判验证）与真实服务端 E2E 冒烟 | 已实施，待提交 |

## 8. 风格链路的结构性缺口（2026-08-25 复查）

> 状态更新（2026-08-25）：下列第 1、3 条已由施工日志第 11、12 条实施，第 2、4、5、6 条仍然成立。

1. ✅ **风格规范从不参与 A/B**（已实施，见施工日志 12）：`skill-benchmark.mjs` 中 champion 与 challenger 都调用同一个 `getStyleProfile()`，风格在评测里是常量而非自变量。第 3 节那套晋升门禁保护的是 `translation_skills`（检索条数、附加指令、QA 阈值），完全不覆盖 `style_profiles`——即真正承载风格的对象。激活风格草稿 = 人看两段散文 + 点按钮，无预演、无回归、无回滚信号。
2. **回溯数据已存但从未读取**：`styleProfileId` 已写入 qa_runs、memories、learning_trajectories，全代码库没有一处按它读回。"v3 时期平均 QA 91，v4 之后 88" 这类回溯对比的原料是齐的，缺的只是聚合查询。这是成本最低的一步。
3. ✅ **只学正例，不学改动**（已实施，见施工日志 11）：风格证据只有 `table-import` 和 `human-accept` 两种来源，`sampleEvidence()` 只把 `{source, target}` 交给蒸馏模型。人工把机器译文 A 改成 B 时 A 被丢弃，而 (A→B) 的差异才是风格信号本身。trajectory 里存了 `initialTranslation` / `finalTranslation`，蒸馏路径不读。同事"忽略"的建议同样只留档不入池。
4. **滚动重写导致风格失忆**：每次蒸馏都是模型拿最近 30 条证据全量重写 instruction，没有 rule id、没有每条规则的命中/违反计数、没有规则生命周期。早期学到的规则会随窗口滚动静默消失，`previousProfile` 只是提示而非约束。
5. **风格证据向量化了却按时间检索**：写入时调用 `embedSource`，Auto QA 取用时是 `getStyleEvidence(..., { limit: 6 })` 取最近 6 条，不带 queryEmbedding 排序；memories 与 qaCases 都有 rank 函数，style evidence 没有。
6. **作用域爆炸**：风格作用域 4 语言 × 9 语体 × 4 领域 = 144 格，每格需 8 条同域证据，多数格子长期填不满，实际生效的是 `CONTENT_TYPES` 里的硬编码 register。

剩余顺序建议：(4) 规则级生命周期是下一个最有价值的改动——现在的蒸馏仍是模型拿最近 30 条证据全量重写，规则没有 id、没有命中计数，早期规则会随窗口滚动静默消失；(2) 的回溯对比（按 `styleProfileId` 聚合 qa_runs）成本很低，可以顺手做掉；(5) 风格证据向量检索与 (6) 作用域稀疏属于长期问题。

配对评测已经让风格改动**可被证伪**，但要真正"按风格进化"，还缺规则级的增删存续——现在能证明"这一版整体更好"，还不能证明"哪一条规则在起作用"。

## 9. 结论

当前版本是"正确性优先、设计诚实、但进化被泄漏数据钉死"的保守系统，实际效果等于"带审计的固定提示词 + 检索增强"。要真正实现自进化，必须先解决 4.1（clean-room 评测），否则所有后续改进都无法被评测系统认可。

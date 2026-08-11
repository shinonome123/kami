# Kami 本地化工作台

面向中文源文到日语、韩语、台湾繁中、泰语的 AI 本地化工作台。Directus + PostgreSQL 提供语言资产后台，四套目标语言术语在存储、权限和检索层强制隔离，不以英文为中间语言。

## 已实现

- Directus 12.2.0 + PostgreSQL 资产后台、表格管理、筛选、审批和修改记录
- 日、韩、繁中、泰四张物理独立术语表和 API 检索入口
- 宣发、公告、道具名、道具描述、UI、规则、对白、社媒等自动语体识别
- 精确、别名、模糊匹配，以及领域/语体/批准状态加权
- `.xlsx` / `.csv` 中外文表格上传，自动识别中文列及日、韩、繁中、泰目标列
- 规则去噪、重复合并、现有术语检查、译法冲突提示与可选 AI 二次清洗
- 导入批次、候选判断依据、原表行号和人工采用结果完整留存在 Directus
- OpenAI-compatible 模型服务，兼容本地 Ollama/LM Studio/vLLM 或云端服务
- 初译 → 双语反思 → 最小修订
- 数字、URL、占位符、强制术语和禁用译法硬 QA
- 译文中实际采用的正式术语以红色虚线标记，悬停可查看中外术语对照
- 近似、错字和字符重排命中只作为智能候选；译文对应表达以蓝色虚线标记，可点击确认并原位替换为正式译法
- 单句翻译与批次 / 文件翻译双模式；支持粘贴长文以及 `.txt`、`.md`、`.docx`、`.xlsx`
- 文件按结构、换行和完整句子自动分段，逐段携带相邻上下文执行翻译、术语检查和 QA
- 批次可暂停续跑、跳过分段、编辑译文、重试失败项，并合并导出为原文件格式
- 收敛为翻译、术语导入、术语库三个页面；页面主操作统一位于页头

## 运行

要求 Node.js 20 或更高版本、Docker Desktop 和 Docker Compose。首次运行：

```powershell
npm run directus:up
npm run directus:provision
npm start
```

然后打开：

- Kami 工作台：`http://127.0.0.1:4173`
- Directus 资产后台：`http://127.0.0.1:8055/admin/content/terms_ja_jp`

管理员邮箱和密码保存在本机 `directus/.env`，该文件已加入 `.gitignore`。Kami 服务端使用单独的最小权限 Service Token，不向浏览器暴露管理员令牌。

常用管理命令：

```powershell
npm run directus:up
npm run directus:down
npm run directus:provision
npm run directus:snapshot
```

`directus:provision` 是幂等的，可以安全地重新检查缺失集合、字段、权限和种子数据。Schema 快照保存在 `directus/schema/snapshot.yaml`。

默认模型地址是本地 Ollama 的 OpenAI-compatible 端点：

```text
Base URL: http://localhost:11434/v1
Model: qwen3:14b
```

可以在界面右上角“模型设置”中修改。Base URL、模型名称和 API Key 会保存在本机 `data/runtime/`；Key 使用 Windows 当前用户级 DPAPI 加密，不会以明文写入项目，也无法由其他 Windows 用户或复制到其他电脑后直接解密。该目录已加入 `.gitignore`。

环境变量优先于本地持久化配置，也可以使用：

```powershell
$env:LLM_BASE_URL='https://your-provider.example/v1'
$env:LLM_API_KEY='your-key'
$env:LLM_MODEL='your-model'
npm start
```

DPAPI 与当前 Windows 用户身份绑定。重装系统、删除 Windows 用户或迁移到另一台电脑时，需要重新输入 Key。

## 数据隔离

正式术语分别存放在四张 PostgreSQL 表中：

```text
terms_ja_jp
terms_ko_kr
terms_zh_hant_tw
terms_th_th
```

每次资产查询和翻译请求必须提交受支持的 `locale`。后端通过固定白名单把 locale 映射到唯一表名，不接受客户端指定任意集合，也不存在跨语言 fallback。`data/assets/*.json` 继续作为可读的初始迁移源和离线回退数据，不是 Directus 模式下的正式写入目标。

共享后台集合包括：

- `corpus_documents`：中文原始语料和切段结果
- `term_import_batches`：表格上传、清洗和入库批次
- `term_candidates`：中外术语候选、目标语言、评分、判断依据和处理状态
- `style_profiles`：目标语言与语体规则

## 批量术语导入

进入“术语导入”，选择 `.xlsx` 或 `.csv`。推荐表头使用“中文、日语、韩语、繁體中文、泰语”；表格可以只含一个目标语言，也可以同时含四个目标语言。系统会：

可直接复制 `samples/term-import-template.csv` 作为导入模板；不需要的目标语言列可以删除。

1. 自动寻找表头和中外文列。
2. 去除网址、纯数字、空值、重复对照和明显完整句子。
3. 检查当前目标语言库中的已存在项及同源词译法冲突。
4. 在启用时调用模型做二次术语判断；模型不可用会自动回退本地规则。
5. 仅把人工勾选的候选写入其对应语言物理表。

候选中文和译法可以在审核表格中修改。自动判定为“需复核”的项目默认不勾选，“已存在”和“已排除”的项目不能直接导入。

## 批次与文件翻译

进入“翻译”，切换到“批次 / 文件翻译”。可以直接粘贴长文，也可以上传 TXT、Markdown、DOCX 或 XLSX 文件。分段不使用固定字数：默认以一个完整句子作为翻译单元，也可以切换为一个自然段、Word 段落或 Excel 单元格作为翻译单元。

系统先展示完整分段队列，不会直接开始扣用模型额度。启动批次时先对整份文档确定统一语体与基础风格，再为每个翻译单元携带上文、下文、文档位置、当前目标语言术语匹配和风格配置。上下文只用于消歧与保持连贯，提示词明确禁止把相邻内容混入当前译文。当前段完成后可以暂停，已完成进度会留在浏览器页面中。每段都会显示 QA 状态，失败项可以继续重试。导出时，未勾选或未完成的部分保留原文；DOCX 写回原段落，XLSX 写回原中文单元格，TXT 与 Markdown 保留原换行结构。

## 测试

```powershell
npm test
node --env-file=directus/.env --test
$env:KAMI_API_E2E='1'; node --env-file=directus/.env --test tests/term-import-api.integration.test.mjs
```

第二条命令会额外运行真实 Directus 读写和四语隔离测试。第三条需要 Kami 已在 4173 端口运行，会执行表格预览、四语分库写入、读取校验和自动清理的完整 API 闭环。

## 当前原型边界

- 旧版 `.xls` 需先另存为 `.xlsx`；JSON、YAML、PO、XLIFF 和游戏资源包尚未接入结构化回写。
- DOCX 会保留文档容器、段落和非文本对象，但一个段落内部跨多个样式 Run 的文字在写回时会合并到首个 Run；复杂排版文档仍建议导出后人工检查。
- 无明确语言表头时，日、韩、泰可依靠文字特征推断；繁中与简中难以只靠字符可靠区分，建议保留表头或手动指定目标语言。
- 当前 AI 只负责候选保留/排除判断，不会擅自改写原表中的中外术语。
- 智能术语当前结合编辑距离、字符重排、别名和模型译文对齐；完全没有词面关联的同义概念仍建议补充别名，后续可增加多语言向量召回。
- 模型质量取决于接入的模型和为各语言积累的正式资产。

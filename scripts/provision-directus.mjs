import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

const baseUrl = String(process.env.DIRECTUS_URL || "http://127.0.0.1:8055").replace(/\/$/, "");
const token = process.env.DIRECTUS_ADMIN_TOKEN || process.env.DIRECTUS_TOKEN;

if (!token) throw new Error("DIRECTUS_ADMIN_TOKEN or DIRECTUS_TOKEN is required");

const localeCollections = {
  "ja-JP": { key: "terms_ja_jp", label: "日语术语库", icon: "translate" },
  "ko-KR": { key: "terms_ko_kr", label: "韩语术语库", icon: "translate" },
  "zh-Hant-TW": { key: "terms_zh_hant_tw", label: "繁体中文（台湾）术语库", icon: "translate" },
  "th-TH": { key: "terms_th_th", label: "泰语术语库", icon: "translate" }
};

const memoryCollections = {
  "ja-JP": { key: "translation_memory_ja_jp", label: "日语翻译记忆" },
  "ko-KR": { key: "translation_memory_ko_kr", label: "韩语翻译记忆" },
  "zh-Hant-TW": { key: "translation_memory_zh_hant_tw", label: "繁体中文（台湾）翻译记忆" },
  "th-TH": { key: "translation_memory_th_th", label: "泰语翻译记忆" }
};

const label = (translation) => [{ language: "zh-CN", translation }];
const choices = (values) => values.map(([text, value]) => ({ text, value }));
const typeMigrations = new Set(["term_candidates.source", "term_candidates.target"]);

function uuidField() {
  return {
    field: "id",
    type: "uuid",
    meta: { hidden: true, readonly: true, interface: "input", special: ["uuid"], sort: 1 },
    schema: { is_primary_key: true, is_nullable: false }
  };
}

function textField(field, translation, { required = false, width = "full", note = null, multiline = false, sort } = {}) {
  return {
    field,
    type: multiline ? "text" : "string",
    meta: {
      interface: multiline ? "input-multiline" : "input",
      required,
      width,
      note,
      sort,
      translations: label(translation)
    },
    schema: { is_nullable: !required }
  };
}

function jsonField(field, translation, { note = null, sort } = {}) {
  return {
    field,
    type: "json",
    meta: { interface: "tags", width: "full", note, sort, translations: label(translation) },
    schema: { is_nullable: true }
  };
}

function selectField(field, translation, values, { defaultValue = null, width = "half", sort } = {}) {
  return {
    field,
    type: "string",
    meta: {
      interface: "select-dropdown",
      options: { choices: choices(values) },
      display: "labels",
      display_options: { choices: choices(values) },
      width,
      sort,
      translations: label(translation)
    },
    schema: { is_nullable: false, default_value: defaultValue }
  };
}

function dateField(field, translation, special, sort) {
  return {
    field,
    type: "timestamp",
    meta: { interface: "datetime", readonly: true, special: [special], width: "half", sort, translations: label(translation) },
    schema: { is_nullable: true }
  };
}

function uniqueInternalField(field, sort) {
  return {
    field,
    type: "string",
    meta: { hidden: true, readonly: true, interface: "input", width: "full", sort },
    schema: { is_nullable: true, is_unique: true }
  };
}

const statusValues = [["草稿", "draft"], ["待审核", "pending"], ["已批准", "approved"], ["已废弃", "deprecated"], ["已归档", "archived"]];
const contentTypeValues = [["宣发文案", "marketing"], ["正式公告", "announcement"], ["游戏内道具名", "item_name"], ["游戏内道具描述", "item_description"], ["UI / 系统提示", "ui"], ["活动规则", "rules"], ["剧情对白", "dialogue"], ["社媒短文案", "social"], ["通用文本", "general"]];

function termFields() {
  return [
    uuidField(),
    textField("source", "中文源词", { required: true, width: "half", sort: 2 }),
    textField("target", "正式译法", { required: true, width: "half", sort: 3 }),
    jsonField("aliases", "中文别名", { note: "只存中文源词的别名", sort: 4 }),
    jsonField("forbidden", "禁用译法", { sort: 5 }),
    jsonField("domains", "业务领域", { sort: 6 }),
    jsonField("content_types", "适用语体", { sort: 7 }),
    selectField("enforcement", "约束级别", [["强制采用", "required"], ["优先参考", "preferred"]], { defaultValue: "required", sort: 8 }),
    selectField("status", "审批状态", statusValues, { defaultValue: "draft", sort: 9 }),
    textField("provenance", "来源", { width: "half", sort: 10 }),
    textField("note", "备注", { multiline: true, sort: 11 }),
    dateField("date_created", "创建时间", "date-created", 12),
    dateField("date_updated", "更新时间", "date-updated", 13)
  ];
}

function memoryFields() {
  return [
    uuidField(),
    textField("source", "简体中文原文", { required: true, multiline: true, sort: 2 }),
    textField("target", "目标语言译文", { required: true, multiline: true, sort: 3 }),
    textField("domain", "业务领域", { width: "half", sort: 4 }),
    selectField("content_type", "内容语体", contentTypeValues, { defaultValue: "general", sort: 5 }),
    textField("channel", "使用渠道", { width: "half", sort: 6 }),
    textField("style_profile_id", "风格版本 ID", { width: "half", sort: 7 }),
    selectField("quality_status", "质量状态", [["人工批准", "human_approved"], ["机器验证", "machine_verified"], ["临时", "provisional"], ["已拒绝", "rejected"]], { defaultValue: "provisional", sort: 8 }),
    { field: "qa_score", type: "float", meta: { interface: "input", width: "half", sort: 9, translations: label("QA 分数") }, schema: { is_nullable: true } },
    textField("provenance", "来源", { width: "half", sort: 10 }),
    textField("source_file", "来源文件", { width: "half", sort: 11 }),
    textField("batch_id", "批次 ID", { width: "half", sort: 12 }),
    { field: "source_row", type: "integer", meta: { interface: "input", width: "half", sort: 13, translations: label("来源行号") }, schema: { is_nullable: true } },
    jsonField("embedding", "语义向量", { note: "embedding 模型生成的归一化向量，用于语义相似度检索。", sort: 14 }),
    dateField("date_created", "创建时间", "date-created", 15),
    dateField("date_updated", "更新时间", "date-updated", 16)
  ];
}

const definitions = [
  ...Object.values(localeCollections).map(({ key, label: collectionLabel, icon }, index) => ({
    collection: key,
    meta: {
      icon,
      note: `${collectionLabel}。与其他目标语言物理隔离。`,
      display_template: "{{source}} → {{target}}",
      group: "localization_assets",
      sort: index + 1,
      accountability: "all",
      versioning: true,
      archive_field: "status",
      archive_value: "archived",
      unarchive_value: "draft",
      archive_app_filter: true,
      translations: label(collectionLabel)
    },
    schema: {},
    fields: termFields()
  })),
  {
    collection: "corpus_documents",
    meta: {
      icon: "article",
      note: "中文原始语料、切段和候选提取结果。",
      display_template: "{{name}}",
      group: "localization_pipeline",
      sort: 1,
      accountability: "all",
      translations: label("中文语料")
    },
    schema: {},
    fields: [
      uuidField(),
      textField("name", "语料名称", { required: true, sort: 2 }),
      textField("source_language", "源语言", { required: true, width: "half", sort: 3 }),
      textField("domain", "业务领域", { width: "half", sort: 4 }),
      textField("content_type", "内容语体", { width: "half", sort: 5 }),
      textField("text", "中文原文", { required: true, multiline: true, sort: 6 }),
      jsonField("segments", "切分句段", { sort: 7 }),
      jsonField("candidates", "术语候选", { sort: 8 }),
      dateField("date_created", "创建时间", "date-created", 9)
    ]
  },
  {
    collection: "term_import_batches",
    meta: {
      icon: "upload_file",
      note: "中外文表格上传、清洗与入库批次记录。",
      display_template: "{{filename}}",
      group: "localization_pipeline",
      sort: 2,
      accountability: "all",
      translations: label("术语导入批次")
    },
    schema: {},
    fields: [
      uuidField(),
      textField("filename", "文件名", { required: true, sort: 2 }),
      textField("file_type", "文件类型", { width: "half", sort: 3 }),
      textField("source_language", "源语言", { width: "half", sort: 4 }),
      textField("requested_locale", "指定目标语言", { width: "half", sort: 5 }),
      { field: "row_count", type: "integer", meta: { interface: "input", width: "half", sort: 6, translations: label("扫描行数") }, schema: { is_nullable: true } },
      { field: "candidate_count", type: "integer", meta: { interface: "input", width: "half", sort: 7, translations: label("候选数量") }, schema: { is_nullable: true } },
      selectField("status", "批次状态", [["审核中", "reviewing"], ["已完成", "completed"], ["已取消", "cancelled"]], { defaultValue: "reviewing", sort: 8 }),
      { field: "ai_used", type: "boolean", meta: { interface: "boolean", width: "half", sort: 9, translations: label("AI 已参与") }, schema: { is_nullable: false, default_value: false } },
      jsonField("summary", "清洗摘要", { sort: 10 }),
      dateField("date_created", "创建时间", "date-created", 11)
    ]
  },
  {
    collection: "term_candidates",
    meta: {
      icon: "manage_search",
      note: "从中文语料提取、等待人工确认的候选术语。",
      display_template: "{{source}}",
      group: "localization_pipeline",
      sort: 3,
      accountability: "all",
      translations: label("术语候选")
    },
    schema: {},
    fields: [
      uuidField(),
      textField("source", "候选中文词", { required: true, multiline: true, sort: 2 }),
      textField("target", "候选译法", { multiline: true, width: "half", sort: 3 }),
      selectField("target_locale", "目标语言", Object.keys(localeCollections).map((locale) => [locale, locale]), { defaultValue: "ja-JP", sort: 4 }),
      selectField("asset_type", "资产类型", [["术语", "term"], ["翻译记忆", "memory"]], { defaultValue: "term", sort: 5 }),
      selectField("content_type", "自动识别语体", contentTypeValues, { defaultValue: "general", sort: 6 }),
      selectField("domain", "自动识别领域", [["游戏", "game"], ["市场营销", "marketing"], ["社区运营", "community"], ["通用", "general"]], { defaultValue: "general", sort: 7 }),
      selectField("enforcement", "自动约束级别", [["强制采用", "required"], ["优先参考", "preferred"]], { defaultValue: "preferred", sort: 8 }),
      { field: "classification_confidence", type: "float", meta: { interface: "input", readonly: true, width: "half", sort: 9, translations: label("分类置信度") }, schema: { is_nullable: true } },
      textField("classification_source", "分类来源", { width: "half", sort: 10 }),
      textField("candidate_key", "候选稳定键", { width: "half", sort: 11 }),
      selectField("candidate_role", "候选角色", [["完整双语句段", "full_pair"], ["句内术语", "embedded_term"]], { defaultValue: "full_pair", sort: 12 }),
      textField("parent_candidate_key", "父级句段候选键", { width: "half", sort: 13 }),
      { field: "parent_row_number", type: "integer", meta: { interface: "input", width: "half", sort: 14, translations: label("父级原表行号") }, schema: { is_nullable: true } },
      jsonField("parent_candidate_keys", "全部父级句段键", { sort: 15 }),
      jsonField("parent_evidence", "句内术语来源证据", { sort: 16 }),
      textField("candidate_origin", "候选提取来源", { width: "half", sort: 14 }),
      textField("term_category", "术语类别", { width: "half", sort: 15 }),
      { field: "extraction_confidence", type: "float", meta: { interface: "input", readonly: true, width: "half", sort: 16, translations: label("术语提取置信度") }, schema: { is_nullable: true } },
      jsonField("source_span", "中文原文位置", { sort: 17 }),
      jsonField("target_span", "目标译文位置", { sort: 18 }),
      { field: "frequency", type: "integer", meta: { interface: "input", width: "half", sort: 6, translations: label("出现频次") }, schema: { is_nullable: false, default_value: 1 } },
      { field: "score", type: "float", meta: { interface: "input", width: "half", sort: 6, translations: label("候选分数") }, schema: { is_nullable: true } },
      textField("batch_id", "导入批次 ID", { width: "half", sort: 7 }),
      textField("corpus_id", "来源语料 ID", { width: "half", sort: 8 }),
      textField("source_file", "来源文件", { width: "half", sort: 9 }),
      { field: "row_number", type: "integer", meta: { interface: "input", width: "half", sort: 10, translations: label("原表行号") }, schema: { is_nullable: true } },
      selectField("decision", "清洗结论", [["可入库", "ready"], ["需复核", "review"], ["已排除", "excluded"]], { defaultValue: "review", sort: 11 }),
      textField("reason", "判断依据", { multiline: true, sort: 12 }),
      selectField("status", "处理状态", [["待确认", "pending"], ["已采用", "accepted"], ["已忽略", "rejected"]], { defaultValue: "pending", sort: 13 }),
      dateField("date_created", "创建时间", "date-created", 14)
    ]
  },
  {
    collection: "batch_runs",
    meta: {
      icon: "playlist_add_check",
      note: "批次翻译的运行进度与人工编辑译文，用于刷新页面后恢复。",
      display_template: "{{filename}}",
      group: "localization_pipeline",
      sort: 3,
      accountability: "all",
      translations: label("翻译批次进度")
    },
    schema: {},
    fields: [
      uuidField(),
      textField("filename", "文件名", { required: true, sort: 2 }),
      selectField("target_locale", "目标语言", Object.keys(localeCollections).map((locale) => [locale, locale]), { sort: 3 }),
      selectField("content_type", "内容语体", contentTypeValues, { defaultValue: "general", sort: 4 }),
      textField("domain", "业务领域", { width: "half", sort: 5 }),
      textField("format", "文件格式", { width: "half", sort: 6 }),
      textField("segmentation_mode", "分段模式", { width: "half", sort: 7 }),
      jsonField("structure", "文档结构", { sort: 8 }),
      jsonField("segments", "分段与译文", { sort: 9 }),
      selectField("task_status", "任务状态", [["进行中", "in_progress"], ["QA 待处理", "review"], ["存在失败", "needs_attention"], ["已完成", "completed"]], { defaultValue: "in_progress", sort: 10 }),
      { field: "total_segments", type: "integer", meta: { interface: "input", readonly: true, width: "half", sort: 11, translations: label("总分段数") }, schema: { is_nullable: true } },
      { field: "completed_segments", type: "integer", meta: { interface: "input", readonly: true, width: "half", sort: 12, translations: label("已完成分段") }, schema: { is_nullable: true } },
      { field: "failed_segments", type: "integer", meta: { interface: "input", readonly: true, width: "half", sort: 13, translations: label("失败分段") }, schema: { is_nullable: true } },
      { field: "qa_pending", type: "integer", meta: { interface: "input", readonly: true, width: "half", sort: 14, translations: label("QA 待处理数") }, schema: { is_nullable: true } },
      dateField("date_created", "创建时间", "date-created", 15),
      dateField("date_updated", "更新时间", "date-updated", 16)
    ]
  },
  {
    collection: "user_profiles",
    meta: {
      icon: "person",
      note: "从人工采纳译文中蒸馏的全局译者偏好画像，按目标语言各一份，翻译时始终注入。",
      display_template: "{{name}}",
      group: "localization_pipeline",
      sort: 4,
      accountability: "all",
      translations: label("译者偏好画像")
    },
    schema: {},
    fields: [
      uuidField(),
      textField("name", "画像名称", { required: true, sort: 2 }),
      selectField("target_locale", "目标语言", Object.keys(localeCollections).map((locale) => [locale, locale]), { sort: 3 }),
      textField("instructions", "偏好规则", { required: true, multiline: true, sort: 4 }),
      jsonField("examples", "正反例", { sort: 5 }),
      { field: "version", type: "integer", meta: { interface: "input", width: "half", sort: 6, translations: label("版本") }, schema: { is_nullable: false, default_value: 1 } },
      textField("parent_id", "上一版本 ID", { width: "half", sort: 7 }),
      { field: "evidence_count", type: "integer", meta: { interface: "input", width: "half", sort: 8, translations: label("证据数量") }, schema: { is_nullable: false, default_value: 0 } },
      selectField("status", "状态", [["启用", "active"], ["草稿", "draft"], ["停用", "inactive"]], { defaultValue: "draft", sort: 9 }),
      dateField("date_updated", "更新时间", "date-updated", 10)
    ]
  },
  {
    collection: "style_profiles",
    meta: {
      icon: "style",
      note: "按目标语言、语体和领域维护的翻译风格规则。",
      display_template: "{{name}}",
      group: "localization_pipeline",
      sort: 4,
      accountability: "all",
      translations: label("语体配置")
    },
    schema: {},
    fields: [
      uuidField(),
      textField("name", "配置名称", { required: true, sort: 2 }),
      selectField("target_locale", "目标语言", Object.keys(localeCollections).map((locale) => [locale, locale]), { sort: 3 }),
      selectField("content_type", "内容语体", contentTypeValues, { defaultValue: "general", sort: 4 }),
      textField("domain", "业务领域", { width: "half", sort: 5 }),
      textField("instructions", "翻译规则", { required: true, multiline: true, sort: 6 }),
      jsonField("examples", "正反例", { sort: 7 }),
      { field: "version", type: "integer", meta: { interface: "input", width: "half", sort: 8, translations: label("版本") }, schema: { is_nullable: false, default_value: 1 } },
      textField("parent_id", "上一版本 ID", { width: "half", sort: 9 }),
      { field: "evidence_count", type: "integer", meta: { interface: "input", width: "half", sort: 10, translations: label("证据数量") }, schema: { is_nullable: false, default_value: 0 } },
      jsonField("evidence_ids", "证据 ID", { sort: 11 }),
      textField("generated_by", "生成模型", { width: "half", sort: 12 }),
      textField("source_batch_id", "来源导入批次 ID", { width: "half", sort: 13 }),
      textField("learning_run_id", "风格学习记录 ID", { width: "half", sort: 14 }),
      selectField("status", "状态", [["启用", "active"], ["草稿", "draft"], ["停用", "inactive"]], { defaultValue: "draft", sort: 13 }),
      dateField("date_updated", "更新时间", "date-updated", 14)
    ]
  },
  ...Object.values(memoryCollections).map(({ key, label: collectionLabel }, index) => ({
    collection: key,
    meta: {
      icon: "history_edu",
      note: `${collectionLabel}。只存该目标语言的已对齐句段，与其他语言物理隔离。`,
      display_template: "{{source}} → {{target}}",
      group: "localization_pipeline",
      sort: 5 + index,
      accountability: "all",
      translations: label(collectionLabel)
    },
    schema: {},
    fields: memoryFields()
  })),
  {
    collection: "style_evidence",
    meta: { icon: "format_quote", note: "从上传表格提取的双语风格证据。", display_template: "{{source}}", group: "localization_pipeline", sort: 9, accountability: "all", translations: label("风格证据") },
    schema: {},
    fields: [
      uuidField(),
      selectField("target_locale", "目标语言", Object.keys(localeCollections).map((locale) => [locale, locale]), { sort: 2 }),
      selectField("content_type", "内容语体", contentTypeValues, { defaultValue: "general", sort: 3 }),
      textField("domain", "业务领域", { width: "half", sort: 4 }),
      textField("source", "简体中文原文", { required: true, multiline: true, sort: 5 }),
      textField("target", "目标语言译文", { required: true, multiline: true, sort: 6 }),
      textField("source_file", "来源文件", { width: "half", sort: 7 }),
      { field: "source_row", type: "integer", meta: { interface: "input", width: "half", sort: 8, translations: label("来源行号") }, schema: { is_nullable: true } },
      textField("batch_id", "来源导入批次 ID", { width: "half", sort: 9 }),
      selectField("status", "状态", [["可用", "accepted"], ["待复核", "pending"], ["已拒绝", "rejected"]], { defaultValue: "pending", sort: 9 }),
      textField("provenance", "来源", { width: "half", sort: 10 }),
      jsonField("embedding", "语义向量", { note: "embedding 模型生成的归一化向量，用于语义相似度检索。", sort: 11 }),
      dateField("date_created", "创建时间", "date-created", 12)
    ]
  },
  {
    collection: "style_learning_runs",
    meta: {
      icon: "auto_awesome",
      note: "每次导入按目标语言、语体和领域生成的可审核风格学习摘要。",
      display_template: "{{filename}} · {{target_locale}} · {{content_type}}",
      group: "localization_pipeline",
      sort: 10,
      accountability: "all",
      translations: label("批次风格学习")
    },
    schema: {},
    fields: [
      uuidField(),
      textField("batch_id", "来源导入批次 ID", { required: true, width: "half", sort: 2 }),
      textField("filename", "来源文件", { width: "half", sort: 3 }),
      selectField("target_locale", "目标语言", Object.keys(localeCollections).map((locale) => [locale, locale]), { sort: 4 }),
      selectField("content_type", "内容语体", contentTypeValues, { defaultValue: "general", sort: 5 }),
      textField("domain", "业务领域", { width: "half", sort: 6 }),
      { field: "evidence_count", type: "integer", meta: { interface: "input", readonly: true, width: "half", sort: 7, translations: label("证据数量") }, schema: { is_nullable: false, default_value: 0 } },
      textField("summary", "本批风格摘要", { required: true, multiline: true, sort: 8 }),
      jsonField("rules", "提炼规则", { sort: 9 }),
      jsonField("examples", "代表性正反例", { sort: 10 }),
      textField("caveat", "适用边界与注意事项", { multiline: true, sort: 11 }),
      { field: "confidence", type: "float", meta: { interface: "input", readonly: true, width: "half", sort: 12, translations: label("学习置信度") }, schema: { is_nullable: true } },
      selectField("status", "审核状态", [["已学习，继续积累", "observed"], ["待审核", "draft"], ["已批准", "approved"], ["已提升为风格指导", "promoted"], ["已拒绝", "rejected"], ["生成失败", "failed"]], { defaultValue: "observed", sort: 13 }),
      textField("promoted_profile_id", "已生成风格规范 ID", { width: "half", sort: 14 }),
      textField("generated_by", "生成模型", { width: "half", sort: 15 }),
      dateField("date_created", "创建时间", "date-created", 16)
    ]
  },
  {
    collection: "learning_trajectories",
    meta: {
      icon: "route",
      note: "记录每个翻译片段实际使用的上下文资产、初译、QA、人工决策与最终译文，作为后续学习归因依据。",
      display_template: "{{project}} · {{target_locale}} · {{batch_id}}/{{segment_id}}",
      group: "localization_learning",
      sort: 1,
      accountability: "all",
      translations: label("翻译学习轨迹")
    },
    schema: {},
    fields: [
      uuidField(),
      selectField("target_locale", "目标语言", Object.keys(localeCollections).map((locale) => [locale, locale]), { sort: 2 }),
      selectField("content_type", "内容语体", contentTypeValues, { defaultValue: "general", sort: 3 }),
      textField("domain", "业务领域", { width: "half", sort: 4 }),
      textField("project", "项目", { width: "half", sort: 5 }),
      textField("batch_id", "批次 ID", { width: "half", sort: 6 }),
      textField("segment_id", "分段 ID", { width: "half", sort: 7 }),
      textField("source", "中文原文", { required: true, multiline: true, sort: 8 }),
      textField("initial_translation", "初始译文", { multiline: true, sort: 9 }),
      textField("final_translation", "最终译文", { multiline: true, sort: 10 }),
      jsonField("context_pack", "实际注入上下文", { sort: 11 }),
      jsonField("asset_refs", "使用资产引用", { sort: 12 }),
      jsonField("term_decisions", "术语决策", { sort: 13 }),
      jsonField("qa_before", "修订前 QA", { sort: 14 }),
      jsonField("qa_after", "修订后 QA", { sort: 15 }),
      jsonField("human_decision", "人工决策", { sort: 16 }),
      jsonField("events", "运行事件", { sort: 17 }),
      textField("model", "执行模型", { width: "half", sort: 18 }),
      textField("prompt_version", "提示词版本", { width: "half", sort: 19 }),
      selectField("status", "轨迹状态", [["运行中", "running"], ["已完成", "completed"], ["待复核", "review"], ["失败", "failed"]], { defaultValue: "running", sort: 20 }),
      textField("error", "失败原因", { multiline: true, sort: 21 }),
      dateField("date_created", "创建时间", "date-created", 22),
      dateField("date_updated", "更新时间", "date-updated", 23)
    ]
  },
  {
    collection: "translation_skills",
    meta: {
      icon: "psychology",
      note: "按目标语言、语体、领域和项目隔离的可版本化翻译策略；同一作用域仅允许一个 champion。",
      display_template: "{{name}} · v{{version}} · {{status}}",
      group: "localization_learning",
      sort: 2,
      accountability: "all",
      translations: label("翻译技能")
    },
    schema: {},
    fields: [
      uuidField(),
      selectField("target_locale", "目标语言", Object.keys(localeCollections).map((locale) => [locale, locale]), { sort: 2 }),
      selectField("content_type", "内容语体", contentTypeValues, { defaultValue: "general", sort: 3 }),
      textField("domain", "业务领域", { width: "half", sort: 4 }),
      textField("project", "项目", { width: "half", sort: 5 }),
      textField("name", "技能名称", { required: true, sort: 6 }),
      textField("description", "技能说明", { multiline: true, sort: 7 }),
      textField("change_reason", "本版变更原因", { multiline: true, sort: 8 }),
      { field: "version", type: "integer", meta: { interface: "input", readonly: true, width: "half", sort: 9, translations: label("版本") }, schema: { is_nullable: false, default_value: 1 } },
      textField("parent_id", "父版本 ID", { width: "half", sort: 10 }),
      selectField("status", "技能状态", [["当前基准", "champion"], ["候选策略", "challenger"], ["草稿", "draft"], ["停用", "inactive"], ["拒绝", "rejected"]], { defaultValue: "draft", sort: 11 }),
      jsonField("strategy", "翻译策略", { note: "分句、上下文召回、术语约束、风格、提示词与 QA 修复方法。", sort: 12 }),
      jsonField("evidence_ids", "来源证据 ID", { sort: 13 }),
      textField("prompt_version", "提示词版本", { width: "half", sort: 14 }),
      jsonField("metrics", "当前指标", { sort: 15 }),
      jsonField("metadata", "元数据", { note: "自动候选生成等内部记账信息。", sort: 16 }),
      uniqueInternalField("version_scope_key", 17),
      uniqueInternalField("champion_scope_key", 18),
      dateField("date_created", "创建时间", "date-created", 19),
      dateField("date_updated", "更新时间", "date-updated", 20)
    ]
  },
  {
    collection: "skill_evaluations",
    meta: {
      icon: "compare_arrows",
      note: "在同一隔离作用域内对 champion 与 challenger 做留出集对照评测，并保留晋升或拒绝依据。",
      display_template: "{{project}} · {{champion_skill_id}} ↔ {{challenger_skill_id}}",
      group: "localization_learning",
      sort: 3,
      accountability: "all",
      translations: label("翻译技能评测")
    },
    schema: {},
    fields: [
      uuidField(),
      selectField("target_locale", "目标语言", Object.keys(localeCollections).map((locale) => [locale, locale]), { sort: 2 }),
      selectField("content_type", "内容语体", contentTypeValues, { defaultValue: "general", sort: 3 }),
      textField("domain", "业务领域", { width: "half", sort: 4 }),
      textField("project", "项目", { width: "half", sort: 5 }),
      textField("champion_skill_id", "Champion 技能 ID", { required: true, width: "half", sort: 6 }),
      textField("challenger_skill_id", "Challenger 技能 ID", { required: true, width: "half", sort: 7 }),
      { field: "sample_count", type: "integer", meta: { interface: "input", readonly: true, width: "half", sort: 8, translations: label("评测样本数") }, schema: { is_nullable: false, default_value: 0 } },
      jsonField("champion_metrics", "Champion 指标", { sort: 9 }),
      jsonField("challenger_metrics", "Challenger 指标", { sort: 10 }),
      jsonField("metric_deltas", "指标差值", { sort: 11 }),
      selectField("decision", "评测决策", [["待决策", "pending"], ["晋升 Challenger", "promote"], ["拒绝 Challenger", "reject"], ["需要人工复核", "needs_review"]], { defaultValue: "pending", sort: 12 }),
      jsonField("report", "评测报告", { sort: 13 }),
      textField("evaluator", "评测器", { width: "half", sort: 14 }),
      dateField("date_created", "创建时间", "date-created", 15),
      dateField("date_updated", "更新时间", "date-updated", 16)
    ]
  },
  {
    collection: "qa_runs",
    meta: { icon: "fact_check", note: "每次翻译的检索证据、质量评分与修订轨迹。", display_template: "{{target_locale}} · {{score}}", group: "localization_pipeline", sort: 10, accountability: "all", translations: label("AIQA 运行记录") },
    schema: {},
    fields: [
      uuidField(),
      selectField("target_locale", "目标语言", Object.keys(localeCollections).map((locale) => [locale, locale]), { sort: 2 }),
      selectField("content_type", "内容语体", contentTypeValues, { defaultValue: "general", sort: 3 }),
      textField("domain", "业务领域", { width: "half", sort: 4 }),
      textField("source", "简体中文原文", { required: true, multiline: true, sort: 5 }),
      textField("initial_translation", "初始译文", { required: true, multiline: true, sort: 6 }),
      textField("final_translation", "最终译文", { required: true, multiline: true, sort: 7 }),
      { field: "score", type: "float", meta: { interface: "input", width: "half", sort: 8, translations: label("最终分数") }, schema: { is_nullable: true } },
      selectField("status", "结论", [["通过", "passed"], ["待人工复核", "review"], ["失败", "failed"]], { defaultValue: "review", sort: 9 }),
      { field: "iterations", type: "integer", meta: { interface: "input", width: "half", sort: 10, translations: label("修订轮数") }, schema: { is_nullable: false, default_value: 0 } },
      jsonField("issues", "问题清单", { sort: 11 }),
      jsonField("term_decisions", "AI 术语裁决", { note: "疑似术语由模型自动判断采用或不适用，并保留理由。", sort: 12 }),
      jsonField("human_decisions", "人工 QA 决定", { note: "逐条记录批准当前译文或要求 AI 修订的人工决定。", sort: 13 }),
      jsonField("references", "检索译例", { sort: 14 }),
      textField("style_profile_id", "风格版本 ID", { width: "half", sort: 15 }),
      textField("model", "审校模型", { width: "half", sort: 16 }),
      textField("batch_id", "批次 ID", { width: "half", sort: 17 }),
      textField("fallback_reason", "未完成原因", { multiline: true, sort: 18 }),
      dateField("date_created", "创建时间", "date-created", 19)
    ]
  },
  {
    collection: "qa_cases",
    meta: { icon: "model_training", note: "低分译文、修订结果和问题类型，作为后续 QA 反例资产。", display_template: "{{target_locale}} · {{score_before}} → {{score_after}}", group: "localization_pipeline", sort: 11, accountability: "all", translations: label("AIQA 问题库") },
    schema: {},
    fields: [
      uuidField(),
      selectField("target_locale", "目标语言", Object.keys(localeCollections).map((locale) => [locale, locale]), { sort: 2 }),
      selectField("content_type", "内容语体", contentTypeValues, { defaultValue: "general", sort: 3 }),
      textField("domain", "业务领域", { width: "half", sort: 4 }),
      textField("source", "简体中文原文", { required: true, multiline: true, sort: 5 }),
      textField("rejected_translation", "问题译文", { required: true, multiline: true, sort: 6 }),
      textField("corrected_translation", "修订译文", { multiline: true, sort: 7 }),
      jsonField("issues", "问题类型与意见", { sort: 8 }),
      { field: "score_before", type: "float", meta: { interface: "input", width: "half", sort: 9, translations: label("修订前分数") }, schema: { is_nullable: true } },
      { field: "score_after", type: "float", meta: { interface: "input", width: "half", sort: 10, translations: label("修订后分数") }, schema: { is_nullable: true } },
      selectField("status", "状态", [["机器验证", "machine_verified"], ["人工批准", "human_approved"], ["待复核", "review"]], { defaultValue: "review", sort: 11 }),
      jsonField("embedding", "语义向量", { note: "embedding 模型生成的归一化向量，用于语义相似度检索。", sort: 12 }),
      dateField("date_created", "创建时间", "date-created", 13)
    ]
  },
  {
    collection: "qa_tasks",
    meta: { icon: "fact_check", note: "Auto QA 页的逐句质检报告快照，用于任务中心回放与留档。", display_template: "{{title}} · {{target_locale}}", group: "localization_pipeline", sort: 12, accountability: "all", translations: label("Auto QA 质检任务") },
    schema: {},
    fields: [
      uuidField(),
      textField("title", "任务标题", { required: true, sort: 2 }),
      selectField("target_locale", "目标语言", Object.keys(localeCollections).map((locale) => [locale, locale]), { sort: 3 }),
      selectField("content_type", "内容语体", contentTypeValues, { defaultValue: "general", sort: 4 }),
      textField("domain", "业务领域", { width: "half", sort: 5 }),
      textField("source_text", "中文原文", { required: true, multiline: true, sort: 6 }),
      textField("translation_text", "目标语言译文", { required: true, multiline: true, sort: 7 }),
      { field: "source_count", type: "integer", meta: { interface: "input", readonly: true, width: "half", sort: 8, translations: label("原文句数") }, schema: { is_nullable: true } },
      { field: "translation_count", type: "integer", meta: { interface: "input", readonly: true, width: "half", sort: 9, translations: label("译文句数") }, schema: { is_nullable: true } },
      { field: "overall_score", type: "float", meta: { interface: "input", readonly: true, width: "half", sort: 10, translations: label("综合分") }, schema: { is_nullable: true } },
      jsonField("dimension_scores", "三维评分", { sort: 11 }),
      jsonField("summary", "问题统计", { sort: 12 }),
      textField("alignment_note", "对齐说明", { multiline: true, sort: 13 }),
      textField("model", "审校模型", { width: "half", sort: 14 }),
      jsonField("report", "完整报告快照", { note: "逐句检查明细，用于报告回放。", sort: 15 }),
      dateField("date_created", "创建时间", "date-created", 16),
      dateField("date_updated", "更新时间", "date-updated", 17)
    ]
  },
  {
    collection: "shares",
    meta: { icon: "share", note: "批次分享验证快照：语素拆解、评分与同事反馈队列。", display_template: "{{filename}}", group: "localization_pipeline", sort: 13, accountability: "all", translations: label("分享验证页") },
    schema: {},
    fields: [
      uuidField(),
      textField("token", "分享令牌", { required: true, width: "half", sort: 2 }),
      textField("batch_id", "来源批次 ID", { width: "half", sort: 3 }),
      textField("qa_task_id", "来源质检任务 ID", { width: "half", sort: 4 }),
      textField("filename", "来源文件", { required: true, sort: 5 }),
      selectField("target_locale", "目标语言", Object.keys(localeCollections).map((locale) => [locale, locale]), { sort: 6 }),
      selectField("content_type", "内容语体", contentTypeValues, { defaultValue: "general", sort: 7 }),
      textField("domain", "业务领域", { width: "half", sort: 8 }),
      jsonField("meta", "质检摘要", { note: "Auto QA 分享的综合分、三维评分、对齐说明与整句级问题。", sort: 9 }),
      jsonField("segments", "分享段落快照", { note: "每段的原文、译文、评分与语素拆解。", sort: 10 }),
      jsonField("feedbacks", "同事反馈队列", { note: "pending 待采纳 / adopted 已入风格证据 / ignored 已忽略。", sort: 11 }),
      selectField("status", "生成状态", [["生成中", "generating"], ["就绪", "ready"], ["失败", "failed"]], { defaultValue: "ready", sort: 12 }),
      { field: "glossed_segments", type: "integer", meta: { interface: "input", readonly: true, width: "half", sort: 13, translations: label("已生成拆解段数") }, schema: { is_nullable: true } },
      { field: "total_segments", type: "integer", meta: { interface: "input", readonly: true, width: "half", sort: 14, translations: label("总段数") }, schema: { is_nullable: true } },
      dateField("date_created", "创建时间", "date-created", 15),
      dateField("date_updated", "更新时间", "date-updated", 16)
    ]
  }
];

async function api(path, { method = "GET", body, allowed = [] } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok && !allowed.includes(response.status)) {
    const details = payload?.errors?.map((error) => error.message).join("; ") || response.statusText;
    throw new Error(`${method} ${path} failed (${response.status}): ${details}`);
  }
  return payload?.data ?? payload;
}

async function waitForDirectus() {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/server/ping`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
  }
  throw new Error(`Directus did not become healthy at ${baseUrl}`);
}

async function ensureFolder(collection, translation, icon, sort) {
  const existing = await api(`/collections/${collection}`, { allowed: [403, 404] });
  const meta = { icon, sort, collapse: "open", translations: label(translation) };
  if (!existing?.collection) await api("/collections", { method: "POST", body: { collection, meta, schema: null } });
  else await api(`/collections/${collection}`, { method: "PATCH", body: { meta } });
}

async function ensureCollection(definition) {
  const existing = await api(`/collections/${definition.collection}`, { allowed: [403, 404] });
  if (!existing?.collection) {
    await api("/collections", { method: "POST", body: definition });
    console.log(`created ${definition.collection}`);
    return;
  }
  await api(`/collections/${definition.collection}`, { method: "PATCH", body: { meta: definition.meta } });
  const currentFields = await api(`/fields/${definition.collection}`);
  const fieldsByName = new Map(currentFields.map((field) => [field.field, field]));
  for (const field of definition.fields) {
    const current = fieldsByName.get(field.field);
    if (!current) await api(`/fields/${definition.collection}`, { method: "POST", body: field });
    else if (typeMigrations.has(`${definition.collection}.${field.field}`) && current.type !== field.type) {
      await api(`/fields/${definition.collection}/${field.field}`, { method: "PATCH", body: field });
      console.log(`migrated ${definition.collection}.${field.field} from ${current.type} to ${field.type}`);
    }
  }
  console.log(`checked ${definition.collection}`);
}

async function migrateSeedAssets() {
  for (const [locale, { key }] of Object.entries(localeCollections)) {
    const sourcePath = resolve(`data/assets/${locale}.json`);
    const source = JSON.parse(await readFile(sourcePath, "utf8"));
    const existing = await api(`/items/${key}?limit=-1&fields=id,source,target`);
    const existingKeys = new Set(existing.map((item) => `${item.source}\u0000${item.target}`));
    const items = source.terms.filter((term) => !existingKeys.has(`${term.source}\u0000${term.target}`)).map((term) => ({
      source: term.source,
      aliases: term.aliases ?? [],
      target: term.target,
      forbidden: term.forbidden ?? [],
      domains: term.domains ?? ["general"],
      content_types: term.contentTypes ?? ["general"],
      enforcement: term.enforcement ?? "required",
      note: term.note ?? "",
      status: term.status ?? "approved",
      provenance: term.provenance ?? "migration"
    }));
    if (items.length) await api(`/items/${key}`, { method: "POST", body: items });
    const count = await api(`/items/${key}?aggregate[count]=*`);
    console.log(`${locale}: ${count[0]?.count ?? source.terms.length} terms`);
  }
}

function learningScopeHash(item, version = null) {
  const scope = [item.target_locale, item.content_type || "general", item.domain || "general", item.project || "default"].join("\u0000");
  return createHash("sha256").update(version == null ? scope : `${scope}\u0000${version}`).digest("hex");
}

async function reconcileTranslationSkillKeys() {
  const items = await api("/items/translation_skills?limit=-1&fields=id,target_locale,content_type,domain,project,version,status,date_created,date_updated");
  const groups = new Map();
  for (const item of items) {
    const scopeKey = learningScopeHash(item);
    if (!groups.has(scopeKey)) groups.set(scopeKey, []);
    groups.get(scopeKey).push(item);
  }
  const updates = [];
  for (const [scopeKey, scoped] of groups) {
    const versions = new Set();
    for (const item of scoped) {
      const version = Math.max(1, Number(item.version) || 1);
      if (versions.has(version)) throw new Error(`translation_skills has duplicate version ${version} in scope ${scopeKey}; resolve it before provisioning`);
      versions.add(version);
    }
    const champions = scoped.filter((item) => item.status === "champion")
      .sort((a, b) => Number(b.version) - Number(a.version) || String(b.date_updated || b.date_created || "").localeCompare(String(a.date_updated || a.date_created || "")));
    const winner = champions[0] || null;
    for (const item of scoped) {
      updates.push({
        id: item.id,
        version_scope_key: learningScopeHash(item, Math.max(1, Number(item.version) || 1)),
        champion_scope_key: item.id === winner?.id ? scopeKey : null,
        ...(item.status === "champion" && item.id !== winner?.id ? { status: "inactive" } : {})
      });
    }
  }
  if (updates.length) await api("/items/translation_skills", { method: "PATCH", body: updates });
  console.log(`translation skill invariants: ${groups.size} scopes checked`);
}

async function ensureServiceAccount() {
  const serviceEmail = process.env.DIRECTUS_SERVICE_EMAIL;
  const servicePassword = process.env.DIRECTUS_SERVICE_PASSWORD;
  const serviceToken = process.env.DIRECTUS_SERVICE_TOKEN;
  if (!serviceEmail || !servicePassword || !serviceToken) throw new Error("Directus service account variables are required");

  const policies = await api(`/policies?filter[name][_eq]=${encodeURIComponent("Kami Translation Service")}&limit=1`);
  const policy = policies[0] || await api("/policies", {
    method: "POST",
    body: {
      name: "Kami Translation Service",
      icon: "api",
      description: "Kami 服务端专用最小权限策略，不允许登录 Data Studio。",
      admin_access: false,
      app_access: false
    }
  });

  const permissionPlan = [
    ...Object.values(localeCollections).flatMap(({ key }) => ["create", "read", "update", "delete"].map((action) => [key, action])),
    ...Object.values(memoryCollections).flatMap(({ key }) => ["create", "read", "update"].map((action) => [key, action])),
    ...["create", "read"].map((action) => ["corpus_documents", action]),
    ...["create", "read", "update"].map((action) => ["term_candidates", action]),
    ...["create", "read", "update"].map((action) => ["term_import_batches", action]),
    ...["create", "read", "update"].map((action) => ["batch_runs", action]),
    ...["create", "read", "update"].map((action) => ["style_profiles", action]),
    ...["create", "read", "update"].map((action) => ["user_profiles", action]),
    ...["create", "read", "update"].map((action) => ["style_evidence", action]),
    ...["create", "read", "update"].map((action) => ["style_learning_runs", action]),
    ...["create", "read", "update"].map((action) => ["learning_trajectories", action]),
    ...["create", "read", "update"].map((action) => ["translation_skills", action]),
    ...["create", "read", "update"].map((action) => ["skill_evaluations", action]),
    ...["create", "read"].map((action) => ["qa_runs", action]),
    ...["create", "read", "update", "delete"].map((action) => ["qa_cases", action]),
    ...["create", "read", "update", "delete"].map((action) => ["qa_tasks", action]),
    ...["create", "read", "update", "delete"].map((action) => ["shares", action])
  ];
  const currentPermissions = await api(`/permissions?filter[policy][_eq]=${policy.id}&limit=-1`);
  const existingPermissionKeys = new Set(currentPermissions.map((permission) => `${permission.collection}:${permission.action}`));
  const missingPermissions = permissionPlan
    .filter(([collection, action]) => !existingPermissionKeys.has(`${collection}:${action}`))
    .map(([collection, action]) => ({ policy: policy.id, collection, action, permissions: {}, validation: {}, presets: null, fields: ["*"] }));
  if (missingPermissions.length) await api("/permissions", { method: "POST", body: missingPermissions });

  const roles = await api(`/roles?filter[name][_eq]=${encodeURIComponent("Kami Service")}&limit=1`);
  const role = roles[0] || await api("/roles", {
    method: "POST",
    body: {
      name: "Kami Service",
      icon: "api",
      description: "仅供 Kami 服务端调用 Directus API。"
    }
  });
  const roleDetails = await api(`/roles/${role.id}?fields=id,policies.policy`);
  const linkedPolicyIds = new Set((roleDetails.policies || []).map((access) => access.policy));
  if (!linkedPolicyIds.has(policy.id)) {
    await api(`/roles/${role.id}`, { method: "PATCH", body: { policies: { create: [{ role: role.id, policy: policy.id }] } } });
  }

  const users = await api(`/users?filter[email][_eq]=${encodeURIComponent(serviceEmail)}&limit=1&fields=id,email`);
  if (!users.length) {
    await api("/users", {
      method: "POST",
      body: {
        email: serviceEmail,
        password: servicePassword,
        status: "active",
        token: serviceToken,
        role: role.id
      }
    });
  } else {
    await api(`/users/${users[0].id}`, { method: "PATCH", body: { token: serviceToken, role: role.id } });
  }
  console.log("service account: ready");
}

await waitForDirectus();
await ensureFolder("localization_assets", "四语术语资产", "translate", 1);
await ensureFolder("localization_pipeline", "语料与规则", "account_tree", 2);
await ensureFolder("localization_learning", "翻译学习与评测", "psychology", 3);
for (const definition of definitions) await ensureCollection(definition);
await reconcileTranslationSkillKeys();
await api("/settings", { method: "PATCH", body: { project_name: "Kami 本地化语言工作台", project_descriptor: "中译日、韩、繁中（台湾）、泰的强隔离语言资产后台", project_color: "#123e31" } });
await ensureServiceAccount();
await migrateSeedAssets();
console.log(`Directus provisioned at ${baseUrl}`);

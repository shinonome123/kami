import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const baseUrl = String(process.env.DIRECTUS_URL || "http://127.0.0.1:8055").replace(/\/$/, "");
const token = process.env.DIRECTUS_ADMIN_TOKEN || process.env.DIRECTUS_TOKEN;

if (!token) throw new Error("DIRECTUS_ADMIN_TOKEN or DIRECTUS_TOKEN is required");

const localeCollections = {
  "ja-JP": { key: "terms_ja_jp", label: "日语术语库", icon: "translate" },
  "ko-KR": { key: "terms_ko_kr", label: "韩语术语库", icon: "translate" },
  "zh-Hant-TW": { key: "terms_zh_hant_tw", label: "繁体中文（台湾）术语库", icon: "translate" },
  "th-TH": { key: "terms_th_th", label: "泰语术语库", icon: "translate" }
};

const label = (translation) => [{ language: "zh-CN", translation }];
const choices = (values) => values.map(([text, value]) => ({ text, value }));

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
      textField("source", "候选中文词", { required: true, sort: 2 }),
      textField("target", "候选译法", { width: "half", sort: 3 }),
      selectField("target_locale", "目标语言", Object.keys(localeCollections).map((locale) => [locale, locale]), { defaultValue: "ja-JP", sort: 4 }),
      { field: "frequency", type: "integer", meta: { interface: "input", width: "half", sort: 5, translations: label("出现频次") }, schema: { is_nullable: false, default_value: 1 } },
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
      selectField("status", "状态", [["启用", "active"], ["草稿", "draft"], ["停用", "inactive"]], { defaultValue: "draft", sort: 8 }),
      dateField("date_updated", "更新时间", "date-updated", 9)
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
  const fieldNames = new Set(currentFields.map((field) => field.field));
  for (const field of definition.fields) {
    if (!fieldNames.has(field.field)) await api(`/fields/${definition.collection}`, { method: "POST", body: field });
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
    ...["create", "read"].map((action) => ["corpus_documents", action]),
    ...["create", "read", "update"].map((action) => ["term_candidates", action]),
    ...["create", "read", "update"].map((action) => ["term_import_batches", action]),
    ["style_profiles", "read"]
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
for (const definition of definitions) await ensureCollection(definition);
await api("/settings", { method: "PATCH", body: { project_name: "Kami 本地化语言工作台", project_descriptor: "中译日、韩、繁中（台湾）、泰的强隔离语言资产后台", project_color: "#123e31" } });
await ensureServiceAccount();
await migrateSeedAssets();
console.log(`Directus provisioned at ${baseUrl}`);

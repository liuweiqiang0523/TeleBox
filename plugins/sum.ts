import { getPrefixes } from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import { Api } from "teleproto";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { getGlobalClient } from "@utils/globalClient";
import { safeGetMessages } from "@utils/safeGetMessages";
import axios from "axios";
import { spawn } from "child_process";
import { JSONFilePreset } from "lowdb/node";
import * as path from "path";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0] || ".";

// Keep individual messages and total prompt size bounded while respecting the user's requested history range.
// We do not cap the requested message count here; only oversized pasted messages/prompts are compacted.
const MAX_MESSAGE_CHARS = 800;
const MAX_SUMMARY_INPUT_CHARS = 28000;
const DURATION_PAGE_SIZE = 100;
const MAX_DURATION_FETCH_PAGES = 24;
const MAX_DURATION_FETCH_MESSAGES = 2000;
const MAX_SUMMARY_SAMPLE_LINES = 220;
const MAX_PERSON_CONTEXT_LINES = 220;
const SUMMARY_MESSAGE_CHAR_BUDGET = 24000;
const PERSON_CONTEXT_RADIUS = 2;
const URL_PATTERN = /https?:\/\/[^\s<>"'，。！？；、）)】\]]+/gi;
const MEME_STOP_WORDS = new Set([
  "这个",
  "那个",
  "不是",
  "没有",
  "可以",
  "已经",
  "还是",
  "就是",
  "然后",
  "现在",
  "什么",
  "怎么",
  "感觉",
  "一下",
  "一个",
  "我们",
  "你们",
  "他们",
  "是不是",
  "为什么",
  "哈哈哈",
]);

const configPath = path.join(
  createDirectoryInAssets("sum"),
  "config.json",
);
const identityCachePath = path.join(
  createDirectoryInAssets("sum"),
  "identity-cache.json",
);

type ProviderType = "openai" | "gemini";

type ProviderConfig = {
  name?: string;
  type?: ProviderType;
  baseUrl: string;
  apiKey: string;
  model: string;
  stream?: boolean;
};

type SumConfig = ProviderConfig & {
  type: ProviderType;
  prompt: string;
  maxOutputLength: number;
  replyMode: boolean;
  fallbacks?: ProviderConfig[];
};

type CachedIdentity = {
  senderId: string;
  names: string[];
  usernames: string[];
  firstSeen: number;
  lastSeen: number;
  count: number;
};

type IdentityCache = {
  users: Record<string, CachedIdentity>;
};

type ProviderUseInfo = {
  name: string;
  type: ProviderType;
  baseUrl: string;
  model: string;
};

type SummaryResult = {
  content: string;
  provider: ProviderUseInfo;
};

type FooterMeta = {
  fetchResult: MessageFetchResult;
  prepared: PreparedInput;
  comparePreviousResult?: MessageFetchResult | null;
};

type SilentMentionLink = {
  text: string;
  display: string;
  href: string;
};

type MarkdownLinkAnchor = {
  token: string;
  html: string;
};

const unifiedSummaryPrompt =
  "你是 Telegram 群聊摘要助手。请把聊天记录提纯成中文 Markdown 摘要。\n\n【绝对要求】\n1. 无论摘要范围是 30 分钟、1 小时、6 小时还是更久，都必须使用同一个固定模板。\n2. 不得增删固定栏目，不得修改栏目标题，不得把短摘要改成其他标题；“话题索引”是长日报/长摘要专用可选栏目，只按开关输出。\n3. 禁止输出 JSON、代码块、解释性前言。\n4. 禁止照抄原文、逐条复述、流水账、凑数编造。\n5. 根据“摘要范围”和“消息数量”自动调整信息密度：时间越短，内容越短；时间越长，归纳层级越高。\n6. 没有明显内容的栏目，直接写“无明显亮点”“无明显金句”“无明确待办”，不要硬凑。\n7. 每条要点必须是一句话，尽量不超过 30 个中文字符。\n8. 禁止使用 **Markdown 加粗**；标题会自动加粗。\n9. 一级标题必须使用「# 📊 群聊消息摘要｜群名」，群名从输入里的「群名」字段获取；所有 Markdown 标题都会在发送时加粗。\n10. 多人重复同一观点时，合并为一个话题；同一用户连续多条短消息，应合并理解为一次表达。\n11. 无法确认的内容不要写成确定结论，使用“可能”“倾向于”“尚未明确”。\n12. 如果输入包含“本地统计”，基本信息、消息总量、活跃时段、核心用户和话唠榜必须以本地统计为准；采样消息只用于判断重点话题、亮点、金句和待办。\n13. 只能使用“聊天消息”里明确出现的信息；禁止补写未出现的新人入群、验证、管理员动作、系统事件或后续进展。\n14. 如果输入提示“短消息模式”，保留固定栏目，但每个栏目只写确有依据的 0-1 条；重点话题不足时不要硬凑。\n15. 重点话题数量必须参考输入里的“重点话题上限”：消息多时可以输出 4-6 个话题，消息少时减少；不要固定只写 3 个。\n16. 如果输入包含“话题索引：启用”，必须在基本信息后输出“## 🗂️ 话题索引”，先列 5-6 个话题标题和极短说明，再展开重点话题；没有该提示时不要输出话题索引。\n17. 必须完整输出到“一句话总结”；如果内容接近上限，优先压缩话题索引、亮点、金句和待办，不允许输出半截内容或截断在某个栏目中。\n18. 话唠榜称号只写短称号，不加括号长解释。\n19. 如果摘要里提到聊天中出现过的外部资源链接，优先写成 [短标题](原始URL)；URL 必须来自输入，最多 5 个，不要编造链接。\n\n【内容筛选规则】\n优先保留：决定、结论、争议、问题、行动项、重要链接、明确情绪变化。\n降低权重：寒暄、表情包、重复附和、单纯玩笑、无上下文短句。\n\n【重点分析对象】\n如果输入中包含“重点分析对象”，仍使用固定模板。\n摘要应优先围绕该用户的发言、观点、问题、行动项和情绪变化。\n需要结合上下文说明别人如何回应该用户。\n如果该用户发言很少，明确说明“该用户发言较少”，不要编造。\n\n【固定输出模板】\n# 📊 群聊消息摘要｜群名\n\n## ⏰ 基本信息\n- 🕒 时间范围：根据消息时间概括\n- 💬 消息总量：约 N 条\n- 📈 活跃时段：HH:mm-HH:mm\n- 👥 核心用户：用户A、用户B、用户C\n\n[仅在输入包含“话题索引：启用”时插入]\n## 🗂️ 话题索引\n- 1. 话题标题｜极短说明\n- 2. 话题标题｜极短说明\n- ... 最多 6 条\n\n## 🏆 话唠榜\n🥇 用户A：约 N 条｜称号：短称号\n🥈 用户B：约 N 条｜称号：短称号\n🥉 用户C：约 N 条｜称号：短称号\n\n## 🔥 重点话题\n### 1️⃣ 话题标题\n👤 主要参与：用户A、用户B\n- ✅ 关键结论：一句话\n- 🔍 细节/注意点：一句话\n\n### 2️⃣ 话题标题\n👤 主要参与：用户A、用户B\n- ✅ 关键结论：一句话\n- 🔍 细节/注意点：一句话\n\n### ... 按“重点话题上限”继续输出，最多不要超过上限\n\n## ✨ 本期亮点\n- ✨ 一句话概括亮点\n- ✨ 一句话概括亮点\n- ✨ 一句话概括亮点\n\n## 💬 金句 / 名场面\n- 🗣️ 用户：「原话或近似原话」\n- 🗣️ 用户：「原话或近似原话」\n\n## ✅ 待办 / 需要关注\n- 🔲 事项：一句话\n- 🔲 事项：一句话\n- 🔲 事项：一句话\n\n## 🧭 一句话总结\n一句话概括最重要信息。";

const personAnalysisPrompt =
  "你是 Telegram 群聊人物分析助手。请只分析指定对象在这段聊天里的表现，不要输出群聊摘要。\n\n【绝对要求】\n1. 只围绕“分析对象”本人，以及别人对他的直接回应来判断。\n2. 禁止输出「群聊消息摘要」「话唠榜」「重点话题」「本期亮点」「待办」等群摘要栏目。\n3. 禁止编造。发言少就明确写“样本较少，只能弱判断”。\n4. 输入中带 ⭐ 的消息才是分析对象本人；没有 ⭐ 时必须说明“未找到精确匹配发言”。\n5. 结论要短，整体控制在 260-520 中文字。\n6. 每一项都要基于聊天记录，不要泛泛夸人。\n7. 输出中文，不要代码块，不要解释前言。\n8. 禁止使用 **Markdown 加粗**；标题会自动加粗。\n9. 如果输入包含“人物分析本地统计”，样本数、本人发言条数、时间范围必须以本地统计为准；不要把“上下文输入条数”误写成本人发言总数。\n10. 标题里的时间范围优先使用请求范围；目标只在其中一段时间出现时，在“基本”里说明目标首尾发言时间。\n11. 代表发言只能引用输入中带 ⭐ 的本人消息；没有合适短句就写“无明显短句”。\n12. 如果输入包含“人物近期变化”，必须输出“🔁 最近变化”，对比当前范围和对照范围的活跃度、关注点、语气或互动对象变化；无明显变化就明确写无明显变化。\n\n【固定输出模板】\n# 📋 @分析对象 人物分析｜时间范围\n\n🧾 样本：本人 N 条｜上下文 N 条｜匹配身份\n🕒 基本：活跃度、主要出现方式、互动对象\n🧠 风格：说话方式和情绪气质\n💡 关注：最常聊/最在意的内容\n🔄 特点：在群里的典型行为模式\n🔁 最近变化：相比对照范围，活跃度/关注点/语气/互动对象有什么变化\n🗣️ 代表发言：\n- 用户：「原话」｜说明一句话\n- 用户：「原话」｜说明一句话\n🧭 总结：一句话判断这个人给人的整体感觉";

const templatePolishPrompt =
  "\n\n【统一观感优化】\n1. 第一眼先给结论：每个模板的第一个内容栏目必须直接说重点，不要铺垫。\n2. 短消息范围不要硬凑：如果输入很少，每个栏目只写确有依据的 0-1 条；没有就写“无明显”。\n3. 长消息范围要归纳：优先写主线、分歧、结论、行动项，不要堆散点。\n4. 每条 bullet 只表达一个判断，尽量一行内结束。\n5. 金句、代表发言、名场面必须来自输入原文或非常接近原文；拿不准就不写。\n6. 不要输出空 bullet、半截 bullet、孤立的符号或模板残留。\n7. 结尾栏目必须收束成一句人能看懂的结论。";

const modePrompts: Record<Exclude<SumMode, "summary" | "person">, string> = {
  hot:
    "你是 Telegram 群聊争议雷达。只分析输入里的争议、分歧、反驳和未定结论，不要做普通流水账摘要。\n\n【版式要求】\n1. 固定使用下面模板，不要增删一级栏目。\n2. 禁止使用 **Markdown 加粗**，标题会自动加粗。\n3. 每条尽量短，避免长篇散文。\n4. 不要制造冲突；没有争议就写“无明显争议”。\n\n【输出模板】\n# 🔥 争议雷达｜群名\n\n## 🎯 最大争议\n- 🧩 争议点：一句话\n- 🅰️ 观点 A：用户｜理由一句话\n- 🅱️ 观点 B：用户｜理由一句话\n- 🧭 当前结论：已解决 / 未解决 / 倾向于什么\n\n## ⚔️ 其他分歧\n- ⚡ 分歧：一句话说明\n- ⚡ 分歧：一句话说明\n- ⚡ 分歧：一句话说明\n\n## 🧯 降温建议\n- 🔎 下一步最该确认：一句话",
  rank:
    "你是 Telegram 群聊贡献榜助手。根据本地统计和聊天内容，生成轻松但不冒犯的贡献榜。不要羞辱、贴负面标签或制造人身攻击。\n\n【版式要求】\n1. 固定使用下面模板，不要增删一级栏目。\n2. 禁止使用 **Markdown 加粗**，标题会自动加粗。\n3. 统计数字必须优先使用输入里的本地统计。\n4. 每个用户说明控制在 1-2 句，称号要有趣但不冒犯。\n\n【输出模板】\n# 🏅 群聊贡献榜｜群名\n\n## 📊 榜单速览\n🥇 发言最多：用户｜约 N 条｜称号：简短称号\n🥈 提问最多：用户｜约 N 次｜称号：简短称号\n🥉 资源贡献：用户｜约 N 个链接｜称号：简短称号\n\n## 🧠 角色观察\n- 👤 用户：贡献方式一句话；代表话题一句话。\n- 👤 用户：贡献方式一句话；代表话题一句话。\n- 👤 用户：贡献方式一句话；代表话题一句话。\n\n## 🎭 今日群像\n一句话概括这段时间的群聊风格。",
  links:
    "你是 Telegram 群聊资源整理助手。只整理输入里的链接、资源、工具、文章、项目、图片/视频线索。不要编造没有出现的链接。\n\n【版式要求】\n1. 固定使用下面模板，不要增删一级栏目。\n2. 禁止使用 **Markdown 加粗**，标题会自动加粗。\n3. URL 必须来自输入，不要改写 URL；重要链接优先写成 [短标题](URL)，方便 Telegram 显示为可点击标题。\n4. 没有链接就明确写“未发现链接”。\n5. 如果输入包含“本地域名归类”，域名归类必须优先参考本地统计。\n\n【输出模板】\n# 🔗 链接与资源整理｜群名\n\n## 🗂️ 域名归类\n- 📁 代码 / GitHub：域名｜用途一句话\n- 📁 视频：域名｜用途一句话\n- 📁 商家 / 服务：域名｜用途一句话\n- 📁 文档 / 知识库：域名｜用途一句话\n\n## 📌 重要链接\n- 🔗 [用途/标题](URL)\n  来源：用户｜时间｜备注一句话\n- 🔗 [用途/标题](URL)\n  来源：用户｜时间｜备注一句话\n\n## 🧩 主题归类\n- 📁 主题：包含哪些链接 / 用途\n- 📁 主题：包含哪些链接 / 用途\n\n## 🧭 最值得回看\n- ⭐ [资源](URL)：原因一句话",
  todo:
    "你是 Telegram 群聊待办提取助手。只提取任务、决定、问题、需要跟进的事项。不要把闲聊写成待办。\n\n【版式要求】\n1. 固定使用下面模板，不要增删一级栏目。\n2. 禁止使用 **Markdown 加粗**，标题会自动加粗。\n3. 不确定负责人就写“未明确”。\n4. 没有待办就写“无明确待办”。\n\n【输出模板】\n# ✅ 待办 / 需要关注｜群名\n\n## 🔲 明确待办\n- 👤 负责人：事项｜时间/条件｜依据一句话\n- 👤 负责人：事项｜时间/条件｜依据一句话\n\n## ❓ 未解决问题\n- ❔ 问题：当前卡点｜需要谁确认\n- ❔ 问题：当前卡点｜需要谁确认\n\n## 🧭 下一步\n- 🔎 最值得先处理：一句话",
  catchup:
    "你是 Telegram 群聊补课助手。用像朋友补课一样的口吻告诉用户错过了什么。重点是好懂、抓重点、少正式腔。\n\n【版式要求】\n1. 固定使用下面模板，不要增删一级栏目。\n2. 禁止使用 **Markdown 加粗**，标题会自动加粗。\n3. 口吻可以轻松，但不要写太长。\n4. 不要逐条复述。\n\n【输出模板】\n# 🧃 错过消息补课｜群名\n\n## 🥤 先说结论\n一小段话说明最重要的事。\n\n## 🧵 发生了什么\n- ✅ 要点一句话\n- ✅ 要点一句话\n- ✅ 要点一句话\n\n## 👀 你可能需要回看\n- 🔎 用户/链接/决定：为什么值得看\n- 🔎 用户/链接/决定：为什么值得看\n\n## 🧭 一句话版本\n一句话总结。",
  vibe:
    "你是 Telegram 群聊气氛观察助手。分析互动气氛、关系、玩笑、认真讨论和情绪变化。必须温和，不要做攻击性人格判断。\n\n【版式要求】\n1. 固定使用下面模板，不要增删一级栏目。\n2. 禁止使用 **Markdown 加粗**，标题会自动加粗。\n3. 只描述互动现象，不给人贴负面人格标签。\n4. 名场面可轻松，但不要冒犯。\n\n【输出模板】\n# 🎭 群聊气氛小剧场｜群名\n\n## 🌡️ 整体气氛\n一句话描述氛围。\n\n## 👥 互动关系\n- 🤝 用户A ↔ 用户B：互动特点一句话\n- 🧭 用户C：在群里的状态一句话\n\n## 🎬 名场面\n- 🗣️ 用户：「原话或近似原话」｜为什么有代表性\n- 🗣️ 用户：「原话或近似原话」｜为什么有代表性\n\n## 🧭 小结\n一句话总结这段时间的群感。",
  about:
    "你是 Telegram 群聊关键词追踪助手。只总结和指定关键词直接相关的消息，并说明上下文。不要泛化到无关话题。\n\n【版式要求】\n1. 固定使用下面模板，不要增删一级栏目。\n2. 禁止使用 **Markdown 加粗**，标题会自动加粗。\n3. ⭐ 标记的消息是关键词直接命中，必须优先参考。\n4. 没有直接命中就明确说明。\n\n【输出模板】\n# 🔎 关键词追踪｜关键词\n\n## 📌 相关结论\n- ✅ 结论：一句话\n- ✅ 结论：一句话\n\n## 🧵 讨论脉络\n- 🕒 时间/用户：说了什么\n- 🕒 时间/用户：别人怎么回应\n\n## ❓ 未解决点\n- ❔ 问题：一句话\n\n## 🧭 一句话总结\n一句话说明这个关键词在群里被怎么讨论。",
  meme:
    "你是 Telegram 群聊热梗观察助手。只提取输入中真实出现或被多次呼应的热词、梗、口头禅和名场面，不要硬造网络梗。\n\n【版式要求】\n1. 固定使用下面模板，不要增删一级栏目。\n2. 禁止使用 **Markdown 加粗**，标题会自动加粗。\n3. 必须优先参考“本地热词候选”和聊天原文。\n4. 没有明显热梗就写“无明显热梗”，不要尬编。\n\n【输出模板】\n# 🧨 群聊热梗榜｜群名\n\n## 🔥 热词 TOP\n🥇 热词/梗：出现方式一句话｜代表用户\n🥈 热词/梗：出现方式一句话｜代表用户\n🥉 热词/梗：出现方式一句话｜代表用户\n\n## 🎬 名场面\n- 🗣️ 用户：「原话或近似原话」｜为什么好笑/有代表性\n- 🗣️ 用户：「原话或近似原话」｜为什么好笑/有代表性\n\n## 🧭 梗味总结\n一句话概括这段时间的群聊笑点。",
  relation:
    "你是 Telegram 群聊人物关系网助手。根据连续对话、互相点名、回复语境和本地互动候选，分析群友之间的互动关系。不要做现实人际推断，只描述群聊互动。\n\n【版式要求】\n1. 固定使用下面模板，不要增删一级栏目。\n2. 禁止使用 **Markdown 加粗**，标题会自动加粗。\n3. 只写聊天里能看出来的互动，不要脑补私下关系。\n4. 关系描述要轻松但不冒犯。\n\n【输出模板】\n# 🕸️ 人物关系网｜群名\n\n## 👥 核心互动\n- 🤝 用户A ↔ 用户B：互动特点一句话｜依据一句话\n- 🤝 用户A ↔ 用户C：互动特点一句话｜依据一句话\n\n## 🧲 话题枢纽\n- 🧭 用户：经常把哪些话题串起来\n- 🧭 用户：经常被谁回应/追问\n\n## 🎭 群聊站位\n一句话概括这段时间的互动结构。",
  story:
    "你是 Telegram 群聊剧情线整理助手。把一段时间的群聊整理成清晰时间线，像补番一样讲发生了什么。不要逐条流水账。\n\n【版式要求】\n1. 固定使用下面模板，不要增删一级栏目。\n2. 禁止使用 **Markdown 加粗**，标题会自动加粗。\n3. 时间线必须按时间顺序。\n4. 只写输入里出现的内容，不能写后续未发生的进展。\n\n【输出模板】\n# 🧵 今日剧情线｜群名\n\n## ⏰ 时间线\n- 🕒 时间段：发生了什么｜主要用户\n- 🕒 时间段：发生了什么｜主要用户\n- 🕒 时间段：发生了什么｜主要用户\n\n## 🎬 转折点\n- 🔁 从什么话题转到什么话题｜谁推动\n- 🔁 从什么话题转到什么话题｜谁推动\n\n## 🧭 一句话剧情\n一句话讲完整段群聊主线。",
  compare:
    "你是 Telegram 群聊对比助手。对比“当前时段”和“对照时段”的聊天活跃度、核心用户、话题变化和气氛变化。必须优先使用输入里的本地统计。\n\n【版式要求】\n1. 固定使用下面模板，不要增删一级栏目。\n2. 禁止使用 **Markdown 加粗**，标题会自动加粗。\n3. 数字以本地统计为准，不能把采样条数当总量。\n4. 如果某一侧消息少，要明确说明样本不足。\n\n【输出模板】\n# 📈 昨日今日对比｜群名\n\n## 📊 数据变化\n- 💬 消息量：当前 N 条｜对照 N 条｜变化一句话\n- 👥 核心用户：当前是谁｜对照是谁\n- ⏰ 活跃时段：当前｜对照\n\n## 🔁 话题变化\n- 🧵 当前更热：一句话\n- 🧵 对照更热：一句话\n- 🧭 延续话题：一句话\n\n## 🎭 气氛变化\n一句话说明今天相比昨天/上一段有什么变化。\n\n## 🧭 一句话结论\n一句话概括最明显变化。",
  track:
    "你是 Telegram 群聊争议追踪助手。追踪这段时间反复出现、尚未完全解决、或者从上一轮延续下来的议题。不要把一次性闲聊写成追踪议题。\n\n【版式要求】\n1. 固定使用下面模板，不要增删一级栏目。\n2. 禁止使用 **Markdown 加粗**，标题会自动加粗。\n3. 只使用输入里出现的证据，不能说“昨天也聊过”除非输入里有对照区或明确提到。\n4. 没有延续争议就写“暂无明显延续争议”。\n\n【输出模板】\n# 🛰️ 争议追踪｜群名\n\n## 🔁 延续议题\n- 🧩 议题：这次怎么被提起｜目前卡在哪里\n- 🧩 议题：这次怎么被提起｜目前卡在哪里\n\n## 📍 当前状态\n- 🧭 已有结论：一句话\n- ❓ 未确认：一句话\n\n## 🔔 下次提醒\n- 👀 如果后续出现什么信息，值得继续跟进",
  quotes:
    "你是 Telegram 群聊金句收藏助手。只挑选输入里真实出现的有代表性的短句、名场面和好笑发言。不要编造原话，不要为了凑数改写成金句。\n\n【版式要求】\n1. 固定使用下面模板，不要增删一级栏目。\n2. 禁止使用 **Markdown 加粗**，标题会自动加粗。\n3. 引号里的内容必须来自聊天原文或非常接近原文。\n4. 没有合适金句就写“无明显金句”。\n\n【输出模板】\n# 💬 金句收藏夹｜群名\n\n## 🏆 今日金句\n🥇 用户：「原话」｜为什么值得收\n🥈 用户：「原话」｜为什么值得收\n🥉 用户：「原话」｜为什么值得收\n\n## 🎬 名场面补充\n- 🗣️ 用户：「原话」｜背景一句话\n- 🗣️ 用户：「原话」｜背景一句话\n\n## 🧭 今日嘴替\n一句话概括这段时间最像群聊精神的一句话。",
  melon:
    "你是 Telegram 群聊吃瓜助手。轻松整理争议、反转、围观、调侃和有戏剧性的互动，但必须温和，不拱火，不做人身攻击。\n\n【版式要求】\n1. 固定使用下面模板，不要增删一级栏目。\n2. 禁止使用 **Markdown 加粗**，标题会自动加粗。\n3. 只描述事情和观点，不给人贴恶意标签。\n4. 没有瓜就写“今天瓜不多，主要是正常聊天”。\n\n【输出模板】\n# 🍉 吃瓜速报｜群名\n\n## 👀 今日瓜点\n- 🍉 事件：谁说了什么｜为什么有人围观\n- 🍉 事件：谁说了什么｜为什么有人围观\n\n## 🔄 反转 / 分歧\n- 🔁 分歧：双方观点一句话\n- 🔁 反转：前后变化一句话\n\n## 🧯 别上头\n一句话给出降温版理解。\n\n## 🧭 一句话吃瓜\n一句话总结最值得看的地方。",
  roast:
    "你是 Telegram 群聊温和吐槽助手。请把这段聊天整理成轻松好笑的槽点日报，但必须基于输入证据，不做人身攻击，不羞辱具体成员。\n\n【版式要求】\n1. 固定使用下面模板，不要增删一级栏目。\n2. 禁止使用 **Markdown 加粗**，标题会自动加粗。\n3. 吐槽对象优先是群聊现象、话题走向、集体行为和名场面，不要给单个人贴恶意标签。\n4. 可以点名用户，语气可以更犀利一点，像熟人群里互损；但刀口只能对准发言、操作、剧情反差和群体行为，不能攻击身份、外貌、地域、性别、疾病、隐私。\n5. 引号里的内容必须来自聊天原文或非常接近原文；没有就写“无明显原话”。\n6. 如果输入内容很少，就写“今天槽点不多”，不要硬编。\n7. 整体要短、准、好笑；消息多时槽点输出 4-6 个，名场面输出 3-5 个；消息少时自然减少。\n8. 不要写“槽点：”这种重复前缀；不要写“以上吐槽仅供娱乐”这类免责声明。\n9. 人名必须独立显示，使用“｜人物：用户A、用户B”或“用户：「原话」”格式；不要把人名和正文连在一起。\n10. 去重优先：同一事件不要同时占据主槽、槽点 TOP 和名场面；同一用户最多出现 2 次，除非他确实是全场唯一主线。\n11. 每个槽点先给 6-12 字标题，再给现场和吐槽；吐槽句可以犀利，但不超过 35 个中文字符。\n\n【输出模板】\n# 😏 今日槽点日报｜群名\n\n## 🎯 今日主槽\n- 🧂 主线：一句话概括最值得吐槽的群聊现象\n- 🎭 槽味：一句话点出为什么好笑，可以稍微狠一点\n\n## 🧂 槽点 TOP\n🥇 短标题｜人物：用户A、用户B\n   现场：一句话说明发生了什么\n   吐槽：一句话，不超过 35 个中文字符\n🥈 短标题｜人物：用户A、用户B\n   现场：一句话说明发生了什么\n   吐槽：一句话，不超过 35 个中文字符\n🥉 短标题｜人物：用户A、用户B\n   现场：一句话说明发生了什么\n   吐槽：一句话，不超过 35 个中文字符\n4️⃣ 短标题｜人物：用户A、用户B\n   现场：一句话说明发生了什么\n   吐槽：一句话，不超过 35 个中文字符\n5️⃣ 短标题｜人物：用户A、用户B\n   现场：一句话说明发生了什么\n   吐槽：一句话，不超过 35 个中文字符\n\n## 🎬 名场面\n- 🗣️ 用户：「短原话」｜一句话说明笑点\n- 🗣️ 用户：「短原话」｜一句话说明笑点\n- 🗣️ 用户：「短原话」｜一句话说明笑点\n- 🗣️ 用户：「短原话」｜一句话说明笑点\n\n## 🧯 轻轻收住\n一句话收束，温和、不拱火、不免责声明。",
};

const defaultConfig: SumConfig = {
  type: "openai",
  baseUrl: "https://api.openai.com",
  apiKey: "",
  model: "gpt-4o-mini",
  stream: false,
  prompt: unifiedSummaryPrompt,
  maxOutputLength: 2400,
  replyMode: true,
  fallbacks: [],
};

type SummaryDensity = {
  label: string;
  targetLength: string;
  topicLimit: number;
  pointLimit: number;
  highlightLimit: number;
  quoteLimit: number;
  todoLimit: number;
  maxOutputLength: number;
};

type ChatMessageRecord = {
  id: number;
  timestamp: number;
  sender: string;
  senderId: string;
  username: string;
  firstName: string;
  lastName: string;
  content: string;
};

type MessageFetchResult = {
  records: ChatMessageRecord[];
  fetchedPages: number;
  reachedFetchLimit: boolean;
  reachedTimeBoundary: boolean;
};

type PreparedInput = {
  lines: string[];
  note: string;
};

type SumMode =
  | "summary"
  | "person"
  | "hot"
  | "rank"
  | "links"
  | "todo"
  | "catchup"
  | "vibe"
  | "about"
  | "meme"
  | "relation"
  | "story"
  | "compare"
  | "track"
  | "quotes"
  | "melon"
  | "roast";

type SpecialRequest = {
  mode: SumMode;
  rangeToken?: string;
  target?: string;
  keyword?: string;
  title: string;
  defaultRangeToken: string;
};

async function getDB() {
  return JSONFilePreset<SumConfig>(configPath, defaultConfig);
}

async function getIdentityDB() {
  return JSONFilePreset<IdentityCache>(identityCachePath, { users: {} });
}

function htmlEscape(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function codeTag(value: unknown): string {
  return `<code>${htmlEscape(value)}</code>`;
}

function getChatDisplayName(msg: any, chatId: string): string {
  const chat = msg?.chat || msg?.peer || {};
  const title =
    chat.title ||
    chat.firstName ||
    chat.username ||
    msg?.chat?.title ||
    msg?.chat?.username;
  return String(title || chatId || "本群").trim();
}

function ensureHeadingHasChatName(text: string, chatName: string): string {
  const title = `📊 群聊消息摘要｜${chatName}`;
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) => /^#\s+/.test(line.trim()));
  if (index >= 0) {
    lines[index] = `# ${title}`;
    return lines.join("\n");
  }
  return `# ${title}\n\n${text.trim()}`;
}

function formatSummaryForTelegram(text: string, chatName: string, mentionLinks: SilentMentionLink[] = []): string {
  const withTitle = ensureHeadingHasChatName(text, chatName);
  return formatMarkdownForTelegram(withTitle, mentionLinks);
}

function buildSilentMentionLinks(records: ChatMessageRecord[]): SilentMentionLink[] {
  const seen = new Set<string>();
  const links: SilentMentionLink[] = [];

  const add = (text: string, display: string, href: string) => {
    const raw = String(text || "").trim();
    if (!raw) return;
    const normalized = raw.replace(/^@/, "").toLowerCase();
    if (normalized.length < 2) return;
    const key = `${raw.toLowerCase()}|${href}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ text: raw, display, href });
  };

  for (const record of records) {
    const username = record.username.replace(/^@/, "").trim();
    if (!username) continue;
    const href = `tg://resolve?domain=${encodeURIComponent(username)}`;
    add(`@${username}`, `＠${username}`, href);
    add(username, username, href);
    add(record.sender, record.sender, href);
  }

  return links.sort((a, b) => b.text.length - a.text.length).slice(0, 120);
}

function linkifySilentMentions(html: string, mentionLinks: SilentMentionLink[]): string {
  if (!mentionLinks.length) return html;
  const tags = html.split(/(<[^>]+>)/g);
  const linked = new Set<string>();

  return tags.map((part) => {
    if (!part || part.startsWith("<")) return part;
    let text = part;
    for (const item of mentionLinks) {
      if (linked.has(item.href)) continue;
      const escapedText = htmlEscape(item.text);
      if (!escapedText || !text.includes(escapedText)) continue;
      const escapedDisplay = htmlEscape(item.display);
      const escapedHref = htmlEscape(item.href);
      text = text.replace(
        new RegExp(escapeRegExp(escapedText), "g"),
        `<a href="${escapedHref}">${escapedDisplay}</a>`,
      );
      linked.add(item.href);
    }
    return text;
  }).join("");
}

function extractMarkdownLinkAnchors(text: string): { text: string; anchors: MarkdownLinkAnchor[] } {
  const anchors: MarkdownLinkAnchor[] = [];
  const replaced = text.replace(/\[([^\]\n]{1,80})\]\((https?:\/\/[^\s)]+)\)/g, (match, label, url) => {
    const title = String(label || "").trim();
    const href = String(url || "").replace(/[，。；、]+$/, "").trim();
    if (!title || !/^https?:\/\//i.test(href)) return match;
    const token = `\uE000SUM_LINK_${anchors.length}\uE000`;
    anchors.push({
      token,
      html: `<a href="${htmlEscape(href)}">${htmlEscape(title)}</a>`,
    });
    return token;
  });
  return { text: replaced, anchors };
}

function restoreMarkdownLinkAnchors(html: string, anchors: MarkdownLinkAnchor[]): string {
  let result = html;
  for (const anchor of anchors) {
    result = result.split(anchor.token).join(anchor.html);
  }
  return result;
}

function formatMarkdownForTelegram(text: string, mentionLinks: SilentMentionLink[] = []): string {
  const extracted = extractMarkdownLinkAnchors(text.trim());
  const html = htmlEscape(extracted.text)
    .replace(
      /^(#{1,6})\s+(.+)$/gm,
      (_match, _level, title) => `<b>${title.trim()}</b>`,
    )
    .replace(/\*\*([^*\n]+)\*\*/g, (_match, content) => `<b>${content.trim()}</b>`);
  return restoreMarkdownLinkAnchors(linkifySilentMentions(html, mentionLinks), extracted.anchors);
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function toInt(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.trunc(n));
}

function parseDuration(value: string | undefined): { minutes: number; label: string } | null {
  const input = String(value || "").trim().toLowerCase();
  const match = input.match(/^(\d+)\s*(h|hr|hrs|hour|hours|小时|m|min|mins|minute|minutes|分钟)$/i);
  if (!match) return null;

  const amount = toInt(match[1], 0);
  if (amount <= 0) return null;

  const unit = match[2].toLowerCase();
  if (["h", "hr", "hrs", "hour", "hours", "小时"].includes(unit)) {
    return { minutes: amount * 60, label: `最近 ${amount} 小时` };
  }

  return { minutes: amount, label: `最近 ${amount} 分钟` };
}

function parseSummaryRequest(
  sub: string | undefined,
  args: string[],
): { rangeToken: string | undefined; target: string } {
  if (sub === "user" || sub === "person") {
    return { rangeToken: args[0], target: args.slice(1).join(" ").trim() };
  }

  const duration = parseDuration(sub);
  const isCount = /^\d+$/.test(sub || "");
  if (duration || isCount || isRangeToken(sub) || !sub) {
    return { rangeToken: sub, target: args.join(" ").trim() };
  }

  return { rangeToken: undefined, target: [sub, ...args].join(" ").trim() };
}

function isRangeToken(value: string | undefined): boolean {
  if (!value) return false;
  return Boolean(parseDuration(value)) || /^\d+$/.test(value) || ["day", "today", "yesterday", "yd", "week", "weekly"].includes(value.toLowerCase());
}

function parseRangeAndRest(
  args: string[],
  defaultRangeToken: string,
): { rangeToken: string; rest: string[] } {
  if (isRangeToken(args[0])) {
    return { rangeToken: args[0], rest: args.slice(1) };
  }
  if (isRangeToken(args[args.length - 1])) {
    return { rangeToken: args[args.length - 1], rest: args.slice(0, -1) };
  }
  return { rangeToken: defaultRangeToken, rest: args };
}

function parseSpecialRequest(sub: string | undefined, args: string[]): SpecialRequest | null {
  const mode = String(sub || "").toLowerCase();
  if (!mode) return null;

  if (mode === "day" || mode === "today" || mode === "日报") {
    if (args.join(" ").trim()) return null;
    return {
      mode: "summary",
      rangeToken: "day",
      title: "群聊日报",
      defaultRangeToken: "day",
    };
  }
  if (mode === "yesterday" || mode === "yd" || mode === "昨天") {
    if (args.join(" ").trim()) return null;
    return {
      mode: "summary",
      rangeToken: "yesterday",
      title: "昨日群聊日报",
      defaultRangeToken: "yesterday",
    };
  }
  if (mode === "week" || mode === "weekly" || mode === "周报") {
    if (args.join(" ").trim()) return null;
    return {
      mode: "summary",
      rangeToken: "week",
      title: "群聊周报",
      defaultRangeToken: "week",
    };
  }

  const modeMap: Record<string, { mode: SumMode; title: string; defaultRangeToken: string }> = {
    hot: { mode: "hot", title: "争议雷达", defaultRangeToken: "6h" },
    debate: { mode: "hot", title: "争议雷达", defaultRangeToken: "6h" },
    rank: { mode: "rank", title: "群聊贡献榜", defaultRangeToken: "24h" },
    links: { mode: "links", title: "链接与资源整理", defaultRangeToken: "24h" },
    link: { mode: "links", title: "链接与资源整理", defaultRangeToken: "24h" },
    todo: { mode: "todo", title: "待办提取", defaultRangeToken: "12h" },
    todos: { mode: "todo", title: "待办提取", defaultRangeToken: "12h" },
    catchup: { mode: "catchup", title: "错过消息补课", defaultRangeToken: "8h" },
    补课: { mode: "catchup", title: "错过消息补课", defaultRangeToken: "8h" },
    vibe: { mode: "vibe", title: "群聊气氛小剧场", defaultRangeToken: "12h" },
    氛围: { mode: "vibe", title: "群聊气氛小剧场", defaultRangeToken: "12h" },
    meme: { mode: "meme", title: "群聊热梗榜", defaultRangeToken: "24h" },
    memes: { mode: "meme", title: "群聊热梗榜", defaultRangeToken: "24h" },
    hotwords: { mode: "meme", title: "群聊热梗榜", defaultRangeToken: "24h" },
    热梗: { mode: "meme", title: "群聊热梗榜", defaultRangeToken: "24h" },
    梗: { mode: "meme", title: "群聊热梗榜", defaultRangeToken: "24h" },
    map: { mode: "relation", title: "人物关系网", defaultRangeToken: "24h" },
    relation: { mode: "relation", title: "人物关系网", defaultRangeToken: "24h" },
    relations: { mode: "relation", title: "人物关系网", defaultRangeToken: "24h" },
    network: { mode: "relation", title: "人物关系网", defaultRangeToken: "24h" },
    关系: { mode: "relation", title: "人物关系网", defaultRangeToken: "24h" },
    story: { mode: "story", title: "今日剧情线", defaultRangeToken: "day" },
    timeline: { mode: "story", title: "今日剧情线", defaultRangeToken: "day" },
    剧情: { mode: "story", title: "今日剧情线", defaultRangeToken: "day" },
    时间线: { mode: "story", title: "今日剧情线", defaultRangeToken: "day" },
    compare: { mode: "compare", title: "昨日今日对比", defaultRangeToken: "day" },
    vs: { mode: "compare", title: "昨日今日对比", defaultRangeToken: "day" },
    对比: { mode: "compare", title: "昨日今日对比", defaultRangeToken: "day" },
    track: { mode: "track", title: "争议追踪", defaultRangeToken: "24h" },
    follow: { mode: "track", title: "争议追踪", defaultRangeToken: "24h" },
    追踪: { mode: "track", title: "争议追踪", defaultRangeToken: "24h" },
    quotes: { mode: "quotes", title: "金句收藏夹", defaultRangeToken: "24h" },
    quote: { mode: "quotes", title: "金句收藏夹", defaultRangeToken: "24h" },
    金句: { mode: "quotes", title: "金句收藏夹", defaultRangeToken: "24h" },
    melon: { mode: "melon", title: "吃瓜速报", defaultRangeToken: "24h" },
    gua: { mode: "melon", title: "吃瓜速报", defaultRangeToken: "24h" },
    吃瓜: { mode: "melon", title: "吃瓜速报", defaultRangeToken: "24h" },
    roast: { mode: "roast", title: "今日槽点日报", defaultRangeToken: "24h" },
    tu: { mode: "roast", title: "今日槽点日报", defaultRangeToken: "24h" },
    吐槽: { mode: "roast", title: "今日槽点日报", defaultRangeToken: "24h" },
    槽点: { mode: "roast", title: "今日槽点日报", defaultRangeToken: "24h" },
  };

  if (mode === "about" || mode === "topic" || mode === "关键词") {
    const parsed = parseRangeAndRest(args, "24h");
    const keyword = parsed.rest.join(" ").trim();
    if (!keyword) return null;
    return {
      mode: "about",
      rangeToken: parsed.rangeToken,
      keyword,
      title: `关键词追踪：${keyword}`,
      defaultRangeToken: "24h",
    };
  }

  const preset = modeMap[mode];
  if (!preset) return null;
  const parsed = parseRangeAndRest(args, preset.defaultRangeToken);
  return {
    ...preset,
    rangeToken: parsed.rangeToken,
  };
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function startOfLocalWeek(date: Date): Date {
  const start = startOfLocalDay(date);
  const day = start.getDay() || 7;
  start.setDate(start.getDate() - day + 1);
  return start;
}

function resolveRangeToken(rangeToken: string | undefined): {
  label: string;
  count?: number;
  startTime?: number;
  endTime?: number;
  durationMinutes: number | null;
} {
  const token = String(rangeToken || "").trim().toLowerCase();
  const now = new Date();

  if (!token) {
    return { label: "最近 100 条可读消息", count: 100, durationMinutes: null };
  }
  if (/^\d+$/.test(token)) {
    const count = toInt(token, 100);
    return { label: `最近 ${count} 条可读消息`, count, durationMinutes: null };
  }

  const duration = parseDuration(token);
  if (duration) {
    const endTime = Math.floor(Date.now() / 1000);
    return {
      label: duration.label,
      startTime: endTime - duration.minutes * 60,
      endTime,
      durationMinutes: duration.minutes,
    };
  }

  if (token === "day" || token === "today") {
    const start = startOfLocalDay(now);
    const endTime = Math.floor(Date.now() / 1000);
    return {
      label: "今天",
      startTime: Math.floor(start.getTime() / 1000),
      endTime,
      durationMinutes: Math.max(1, Math.ceil((endTime - Math.floor(start.getTime() / 1000)) / 60)),
    };
  }
  if (token === "yesterday" || token === "yd") {
    const today = startOfLocalDay(now);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    return {
      label: "昨天",
      startTime: Math.floor(yesterday.getTime() / 1000),
      endTime: Math.floor(today.getTime() / 1000) - 1,
      durationMinutes: 24 * 60,
    };
  }
  if (token === "week" || token === "weekly") {
    const start = startOfLocalWeek(now);
    const endTime = Math.floor(Date.now() / 1000);
    return {
      label: "本周",
      startTime: Math.floor(start.getTime() / 1000),
      endTime,
      durationMinutes: Math.max(1, Math.ceil((endTime - Math.floor(start.getTime() / 1000)) / 60)),
    };
  }

  return { label: "最近 100 条可读消息", count: 100, durationMinutes: null };
}

function getSummaryDensity(durationMinutes: number | null, count: number): SummaryDensity {
  const largeTopicLimit = count >= 1000 ? 6 : count >= 500 ? 5 : count >= 250 ? 4 : 3;
  const largeTargetLength = count >= 1000 ? "1800-2600 中文字，必须完整收尾" : count >= 500 ? "1400-2000 中文字，必须完整收尾" : "900-1400 中文字";
  const largeMaxOutputLength = count >= 1000 ? 4800 : count >= 500 ? 3800 : 2400;

  if (durationMinutes === null) {
    if (count <= 50) {
      return {
        label: "极简",
        targetLength: "150-250 中文字",
        topicLimit: 1,
        pointLimit: 1,
        highlightLimit: 1,
        quoteLimit: 1,
        todoLimit: 1,
        maxOutputLength: 900,
      };
    }
    if (count <= 150) {
      return {
        label: "轻量",
        targetLength: "300-500 中文字",
        topicLimit: 2,
        pointLimit: 2,
        highlightLimit: 2,
        quoteLimit: 1,
        todoLimit: 2,
        maxOutputLength: 1200,
      };
    }
    return {
      label: "标准",
      targetLength: "500-800 中文字",
      topicLimit: count >= 250 ? 4 : 3,
      pointLimit: 2,
      highlightLimit: 3,
      quoteLimit: 2,
      todoLimit: 3,
      maxOutputLength: count >= 250 ? 1900 : 1600,
    };
  }

  if (durationMinutes <= 30) {
    return {
      label: "极简",
      targetLength: "150-250 中文字",
      topicLimit: 1,
      pointLimit: 1,
      highlightLimit: 1,
      quoteLimit: 1,
      todoLimit: 1,
      maxOutputLength: 900,
    };
  }
  if (durationMinutes <= 120) {
    return {
      label: "轻量",
      targetLength: "300-500 中文字",
      topicLimit: 2,
      pointLimit: 2,
      highlightLimit: 2,
      quoteLimit: 1,
      todoLimit: 2,
      maxOutputLength: 1200,
    };
  }
  if (durationMinutes < 360) {
    return {
      label: "标准",
      targetLength: count >= 250 ? "700-1000 中文字" : "500-800 中文字",
      topicLimit: count >= 250 ? 4 : 3,
      pointLimit: 2,
      highlightLimit: 3,
      quoteLimit: 2,
      todoLimit: 3,
      maxOutputLength: count >= 250 ? 1900 : 1600,
    };
  }
  return {
    label: "长时段归纳",
    targetLength: largeTargetLength,
    topicLimit: largeTopicLimit,
    pointLimit: 2,
    highlightLimit: count >= 1000 ? 3 : count >= 500 ? 4 : 3,
    quoteLimit: 2,
    todoLimit: count >= 1000 ? 3 : count >= 500 ? 4 : 3,
    maxOutputLength: largeMaxOutputLength,
  };
}

function buildSystemPrompt(configPrompt: string | undefined): string {
  const prompt = String(configPrompt || "").trim();
  const isLegacyPrompt =
    !prompt ||
    prompt.includes("群聊短摘要") ||
    prompt.includes("短摘要也必须") ||
    prompt.includes("活跃排行榜") ||
    prompt.includes("总长度控制在 1600 中文字以内");

  if (isLegacyPrompt || prompt === unifiedSummaryPrompt) {
    return `${unifiedSummaryPrompt}${templatePolishPrompt}`;
  }

  return `${unifiedSummaryPrompt}${templatePolishPrompt}\n\n【自定义补充要求】\n${prompt}`;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function openAIChatCompletionsUrl(baseUrl: string): string {
  const base = trimTrailingSlash(baseUrl);
  // Accept both provider roots (https://host) and OpenAI-compatible roots (https://host/v1).
  // Before this guard, a configured /v1 endpoint became /v1/v1/chat/completions.
  return base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

function compactText(value: string, maxChars = MAX_MESSAGE_CHARS): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…[已截断${text.length - maxChars}字]`;
}

function compactSummaryInput(input: string): string {
  if (input.length <= MAX_SUMMARY_INPUT_CHARS) return input;
  const marker = "\n聊天消息：\n";
  const index = input.indexOf(marker);
  if (index < 0) return input.slice(-MAX_SUMMARY_INPUT_CHARS);
  const header = input.slice(0, index + marker.length);
  const budget = Math.max(6000, MAX_SUMMARY_INPUT_CHARS - header.length);
  return `${header}[系统提示：原始消息过长，已优先保留最近内容]\n${input.slice(-budget)}`;
}

function stripThinking(text: string): string {
  return text
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();
}

function splitLongText(text: string, maxLength = 3500): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text.trim();

  while (remaining.length > maxLength) {
    let index = remaining.lastIndexOf("\n\n", maxLength);
    if (index < maxLength * 0.45) {
      index = remaining.lastIndexOf("\n", maxLength);
    }
    if (index < maxLength * 0.45) {
      index = remaining.lastIndexOf("。", maxLength);
      if (index > 0) index += 1;
    }
    if (index < maxLength * 0.45) {
      index = maxLength;
    }

    chunks.push(remaining.slice(0, index).trim());
    remaining = remaining.slice(index).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

function withPartHeader(parts: string[]): string[] {
  if (parts.length <= 1) return parts;
  return parts.map((part, index) => `📄 摘要分段 ${index + 1}/${parts.length}\n\n${part}`);
}

function parseOpenAIStream(text: string): string | null {
  if (!text.trim().startsWith("data:")) return null;

  const chunks: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;

    const raw = trimmed.slice(5).trim();
    if (!raw || raw === "[DONE]") continue;

    try {
      const data = JSON.parse(raw);
      for (const choice of data?.choices || []) {
        const content = choice?.delta?.content || choice?.message?.content;
        if (typeof content === "string") chunks.push(content);
      }
    } catch {
      // Ignore malformed stream fragments and keep parsing later chunks.
    }
  }

  const content = chunks.join("").trim();
  return content || null;
}

async function postJsonWithCurl(
  url: string,
  apiKey: string,
  payload: Record<string, unknown>,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn("curl", [
      "--http1.1",
      "-sS",
      "--max-time",
      "120",
      url,
      "-H",
      `Authorization: Bearer ${apiKey}`,
      "-H",
      "Content-Type: application/json",
      "--data-binary",
      "@-",
    ]);

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const text = stdout.trim();
      if (text) {
        const streamContent = parseOpenAIStream(text);
        if (streamContent) {
          resolve({ choices: [{ message: { content: streamContent } }] });
          return;
        }

        try {
          const data = JSON.parse(text);
          if (data?.error?.message) {
            reject(new Error(data.error.message));
            return;
          }
          resolve(data);
          return;
        } catch {
          // Fall through to the regular error path with a concise message.
        }
      }

      reject(new Error(stderr.trim() || `接口请求失败，curl 退出码 ${code}`));
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

function valueToString(value: any): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && typeof value.toString === "function") {
    const text = value.toString();
    return text === "[object Object]" ? "" : String(text);
  }
  return String(value);
}

function createMessageRecord(item: unknown): ChatMessageRecord | null {
  const msg = item as any;
  if (!msg?.message && !msg?.media) return null;

  const timestamp = Number(msg.date || 0);
  if (!timestamp) return null;

  let content = String(msg.message || "").trim();
  if (!content && msg.media) {
    content = "[媒体消息]";
  }
  if (!content) return null;

  const senderInfo = msg.sender || {};
  const firstName = String(senderInfo.firstName || "").trim();
  const lastName = String(senderInfo.lastName || "").trim();
  const username = String(senderInfo.username || "").trim();
  const senderId =
    valueToString(msg.senderId) ||
    valueToString(senderInfo.id) ||
    valueToString(msg.fromId?.userId) ||
    "";
  const fullName = [firstName, lastName].filter(Boolean).join(" " ).trim();
  const sender = fullName || firstName || username || senderId || "未知用户";

  return {
    id: Number(msg.id || 0),
    timestamp,
    sender,
    senderId,
    username,
    firstName,
    lastName,
    content: compactText(content),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isSumSelfNoiseRecord(record: ChatMessageRecord): boolean {
  const content = record.content.trim();
  if (!content) return true;

  if (
    content === "⏳ 正在读取消息并生成摘要..." ||
    content.startsWith("❌ 摘要失败") ||
    content.startsWith("没有找到可总结的文本消息")
  ) {
    return true;
  }

  const summaryHeadings = [
    "📊 群聊消息摘要",
    "📋 @",
    "🔥 争议雷达",
    "🏅 群聊贡献榜",
    "🔗 链接与资源整理",
    "✅ 待办 / 需要关注",
    "🧃 错过消息补课",
    "🎭 群聊气氛小剧场",
    "🔎 关键词追踪",
    "🧨 群聊热梗榜",
    "🕸️ 人物关系网",
    "🧵 今日剧情线",
    "📈 昨日今日对比",
    "🛰️ 争议追踪",
    "💬 金句收藏夹",
    "🍉 吃瓜速报",
  ];
  const normalized = content.replace(/^#+\s*/, "");
  if (summaryHeadings.some((heading) => normalized.startsWith(heading))) {
    return true;
  }

  return prefixes.some((prefix) => {
    const escaped = escapeRegExp(prefix);
    return new RegExp(`^${escaped}sum(?:\\s|$)`, "i").test(content);
  });
}

function sortRecords(records: ChatMessageRecord[]): ChatMessageRecord[] {
  return [...records].sort((a, b) => a.timestamp - b.timestamp || a.id - b.id);
}

function recordToLine(
  record: ChatMessageRecord,
  options: { mark?: boolean; includeIdentity?: boolean; maxContentChars?: number } = {},
): string {
  const time = formatDate(new Date(record.timestamp * 1000));
  const identityParts = [record.sender];
  if (options.includeIdentity && record.username) identityParts.push(`@${record.username}`);
  if (options.includeIdentity && record.senderId) identityParts.push(`id:${record.senderId}`);
  const marker = options.mark ? "⭐ " : "";
  const content = compactText(record.content, options.maxContentChars || MAX_MESSAGE_CHARS);
  return `${marker}[${time}] ${identityParts.join(" " )}: ${content}`;
}

function addUnique(values: string[], value: string, limit = 8): string[] {
  const text = value.trim();
  if (!text) return values;
  const exists = values.some((item) => normalizeTargetText(item) === normalizeTargetText(text));
  if (exists) return values;
  return [...values, text].slice(-limit);
}

async function updateIdentityCache(records: ChatMessageRecord[]): Promise<IdentityCache> {
  const db = await getIdentityDB();
  const now = Math.floor(Date.now() / 1000);
  db.data.users ||= {};

  for (const record of records) {
    const key = getUserKey(record);
    if (!key) continue;

    const existing = db.data.users[key] || {
      senderId: record.senderId,
      names: [],
      usernames: [],
      firstSeen: record.timestamp || now,
      lastSeen: 0,
      count: 0,
    };
    existing.senderId = existing.senderId || record.senderId;
    existing.names = addUnique(existing.names || [], record.sender);
    if (record.firstName) existing.names = addUnique(existing.names, record.firstName);
    if (record.lastName) existing.names = addUnique(existing.names, record.lastName);
    if (record.username) existing.usernames = addUnique(existing.usernames || [], record.username);
    existing.firstSeen = Math.min(existing.firstSeen || record.timestamp || now, record.timestamp || now);
    existing.lastSeen = Math.max(existing.lastSeen || 0, record.timestamp || now);
    existing.count = (existing.count || 0) + 1;
    db.data.users[key] = existing;
  }

  const users = Object.entries(db.data.users)
    .sort((a, b) => (b[1].lastSeen || 0) - (a[1].lastSeen || 0))
    .slice(0, 2000);
  db.data.users = Object.fromEntries(users);
  await db.write();
  return db.data;
}

async function getChatMessageRecords(chatId: string, count: number): Promise<MessageFetchResult> {
  const client = await getGlobalClient();
  if (!client) throw new Error("Telegram 客户端未初始化");

  const messages = await safeGetMessages(client, chatId, { limit: toInt(count, 100) });
  const records = messages
    .map(createMessageRecord)
    .filter((record): record is ChatMessageRecord => Boolean(record))
    .filter((record) => !isSumSelfNoiseRecord(record));

  return {
    records: sortRecords(records),
    fetchedPages: messages.length ? 1 : 0,
    reachedFetchLimit: false,
    reachedTimeBoundary: true,
  };
}

async function getChatMessages(chatId: string, count: number): Promise<string[]> {
  const result = await getChatMessageRecords(chatId, count);
  return result.records.map((record) => recordToLine(record));
}

async function getChatMessageRecordsByDuration(
  chatId: string,
  durationMinutes: number,
): Promise<MessageFetchResult> {
  const endTime = Math.floor(Date.now() / 1000);
  return getChatMessageRecordsByTimeRange(chatId, endTime - durationMinutes * 60, endTime);
}

async function getChatMessageRecordsByTimeRange(
  chatId: string,
  startTime: number,
  endTime: number,
): Promise<MessageFetchResult> {
  const client = await getGlobalClient();
  if (!client) throw new Error("Telegram 客户端未初始化");

  const records: ChatMessageRecord[] = [];
  let offsetId = 0;
  let fetchedPages = 0;
  let reachedFetchLimit = false;
  let reachedTimeBoundary = false;
  const seenIds = new Set<number>();

  while (true) {
    if (fetchedPages >= MAX_DURATION_FETCH_PAGES || records.length >= MAX_DURATION_FETCH_MESSAGES) {
      reachedFetchLimit = true;
      break;
    }

    const batch = await safeGetMessages(client, chatId, {
      limit: DURATION_PAGE_SIZE,
      offsetId,
      addOffset: 0,
    });
    if (!batch.length) break;
    fetchedPages += 1;

    let reachedOlderThanRange = false;
    for (const item of batch) {
      const msg = item as any;
      const id = Number(msg.id || 0);
      if (id && seenIds.has(id)) continue;
      if (id) seenIds.add(id);

      const msgTime = Number(msg.date || 0);
      if (!msgTime) continue;
      if (msgTime < startTime) {
        reachedOlderThanRange = true;
        continue;
      }
      if (msgTime > endTime) continue;

      const record = createMessageRecord(msg);
      if (record && !isSumSelfNoiseRecord(record)) records.push(record);
    }

    const last = batch[batch.length - 1] as any;
    const nextOffsetId = Number(last?.id || 0);
    if (!nextOffsetId || nextOffsetId === offsetId || reachedOlderThanRange) {
      reachedTimeBoundary = reachedOlderThanRange;
      break;
    }
    offsetId = nextOffsetId;
  }

  return {
    records: sortRecords(records),
    fetchedPages,
    reachedFetchLimit,
    reachedTimeBoundary,
  };
}

async function getChatMessagesByDuration(
  chatId: string,
  durationMinutes: number,
): Promise<string[]> {
  const result = await getChatMessageRecordsByDuration(chatId, durationMinutes);
  return result.records.map((record) => recordToLine(record));
}

function pickEvenIndexes(length: number, count: number): number[] {
  if (count <= 0 || length <= 0) return [];
  if (count >= length) return Array.from({ length }, (_value, index) => index);
  if (count === 1) return [Math.floor(length / 2)];

  const indexes = new Set<number>();
  for (let index = 0; index < count; index += 1) {
    indexes.add(Math.round((index * (length - 1)) / (count - 1)));
  }
  return [...indexes].sort((a, b) => a - b);
}

function pickEvenValues<T>(values: T[], count: number): T[] {
  return pickEvenIndexes(values.length, count).map((index) => values[index]);
}

function sampleRecords(records: ChatMessageRecord[], maxLines: number): { records: ChatMessageRecord[]; note: string } {
  if (records.length <= maxLines) {
    return { records, note: `完整输入 ${records.length} 条可读消息` };
  }

  const headCount = Math.min(40, Math.max(10, Math.floor(maxLines * 0.18)));
  const tailCount = Math.min(100, Math.max(30, Math.floor(maxLines * 0.45)));
  const middleCount = Math.max(0, maxLines - headCount - tailCount);
  const indexes = new Set<number>();

  for (let index = 0; index < Math.min(headCount, records.length); index += 1) {
    indexes.add(index);
  }
  for (let index = Math.max(headCount, records.length - tailCount); index < records.length; index += 1) {
    indexes.add(index);
  }

  const middleStart = headCount;
  const middleEnd = Math.max(middleStart, records.length - tailCount);
  const middleLength = middleEnd - middleStart;
  for (const index of pickEvenIndexes(middleLength, middleCount)) {
    indexes.add(middleStart + index);
  }

  const sampled = [...indexes]
    .sort((a, b) => a - b)
    .slice(0, maxLines)
    .map((index) => records[index]);

  return {
    records: sampled,
    note: `原始 ${records.length} 条，已按时间采样为 ${sampled.length} 条：保留开头、均匀覆盖中段，并保留最近消息`,
  };
}

function compactLinesToBudget(lines: string[], budget: number): string[] {
  if (lines.join("\n").length <= budget) return lines;
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const next = used + line.length + 1;
    if (next > budget) {
      if (!kept.some((item) => item.includes("输入过长"))) kept.push("[系统提示：输入过长，后续代表性消息已省略]");
      break;
    }
    kept.push(line);
    used = next;
  }
  return kept;
}

function prepareFlatSummaryInput(records: ChatMessageRecord[]): PreparedInput {
  let maxLines = MAX_SUMMARY_SAMPLE_LINES;
  let maxContentChars = 180;
  let sampled = sampleRecords(records, maxLines);
  let lines = sampled.records.map((record) => recordToLine(record, { maxContentChars }));

  while (lines.join("\n").length > SUMMARY_MESSAGE_CHAR_BUDGET && maxLines > 80) {
    maxLines = Math.max(80, Math.floor(maxLines * 0.75));
    maxContentChars = Math.max(100, maxContentChars - 30);
    sampled = sampleRecords(records, maxLines);
    lines = sampled.records.map((record) => recordToLine(record, { maxContentChars }));
  }

  return { lines, note: sampled.note };
}

function segmentRecordsByTime(records: ChatMessageRecord[], maxSegments = 8): ChatMessageRecord[][] {
  const sorted = sortRecords(records);
  if (sorted.length <= 1) return sorted.length ? [sorted] : [];
  const first = sorted[0].timestamp;
  const last = sorted[sorted.length - 1].timestamp;
  const span = Math.max(1, last - first + 1);
  const segmentCount = Math.min(maxSegments, Math.max(2, Math.ceil(sorted.length / 260)));
  const segmentSeconds = Math.max(1, Math.ceil(span / segmentCount));
  const segments = Array.from({ length: segmentCount }, () => [] as ChatMessageRecord[]);

  for (const record of sorted) {
    const index = Math.min(segmentCount - 1, Math.floor((record.timestamp - first) / segmentSeconds));
    segments[index].push(record);
  }
  return segments.filter((segment) => segment.length > 0);
}

function segmentSummaryLines(segment: ChatMessageRecord[], index: number, total: number): string[] {
  const sorted = sortRecords(segment);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const prepared = prepareFlatSummaryInput(sorted);
  const topUsers = topUserStats(sorted, 4).map((user) => `${user.sender} ${user.count} 条`).join("；") || "无";
  const activeHours = buildActiveHourStats(sorted, 2).join("；") || "无";
  const linkCount = sorted.reduce((sum, record) => sum + extractUrls(record.content).length, 0);
  const questionCount = sorted.reduce((sum, record) => sum + (isQuestion(record.content) ? 1 : 0), 0);

  return [
    `分段 ${index + 1}/${total}：${formatDate(new Date(first.timestamp * 1000))} 至 ${formatDate(new Date(last.timestamp * 1000))}`,
    `本段统计：${sorted.length} 条；核心用户：${topUsers}；活跃时段：${activeHours}；链接 ${linkCount}；问题 ${questionCount}`,
    ...prepared.lines.slice(0, Math.max(18, Math.floor(150 / total))),
  ];
}

function prepareSegmentedSummaryInput(records: ChatMessageRecord[]): PreparedInput {
  const segments = segmentRecordsByTime(records);
  const lines = [
    "长时间范围分段输入：",
    "请先分别理解每个时间段，再归纳全局主线；总量、核心用户和活跃时段必须以本地统计为准。",
    "",
    ...segments.flatMap((segment, index) => [
      ...segmentSummaryLines(segment, index, segments.length),
      "",
    ]),
  ];

  const compacted = compactLinesToBudget(lines, SUMMARY_MESSAGE_CHAR_BUDGET);
  return {
    lines: compacted,
    note: `分段 ${segments.length} 段${compacted.length < lines.length ? "，已压缩" : ""}`,
  };
}

function prepareSummaryInput(records: ChatMessageRecord[]): PreparedInput {
  if (records.length >= 520) return prepareSegmentedSummaryInput(records);
  return prepareFlatSummaryInput(records);
}

function normalizeTargetText(value: string): string {
  return value
    .trim()
    .replace(/^@+/, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function parseKeywordQuery(keyword: string): { positives: string[]; negatives: string[]; label: string } {
  const tokens = Array.from(keyword.matchAll(/"([^"]+)"|'([^']+)'|[^,\s，、]+/g))
    .map((match) => (match[1] || match[2] || match[0]).trim())
    .filter(Boolean);
  const positives: string[] = [];
  const negatives: string[] = [];

  for (const token of tokens) {
    if (token.startsWith("-") && token.length > 1) {
      negatives.push(token.slice(1));
      continue;
    }
    positives.push(token.replace(/^\+/, ""));
  }

  return {
    positives: positives.filter(Boolean),
    negatives: negatives.filter(Boolean),
    label: [
      positives.length ? `包含：${positives.join(" / ")}` : "包含：未指定",
      negatives.length ? `排除：${negatives.join(" / ")}` : "",
    ].filter(Boolean).join("；"),
  };
}

function recordMatchesKeywordQuery(record: ChatMessageRecord, query: { positives: string[]; negatives: string[] }): boolean {
  const normalizedContent = normalizeTargetText(record.content);
  if (!normalizedContent) return false;
  const hitsPositive = query.positives.length
    ? query.positives.some((term) => normalizedContent.includes(normalizeTargetText(term)))
    : false;
  if (!hitsPositive) return false;
  const hitsNegative = query.negatives.some((term) => normalizedContent.includes(normalizeTargetText(term)));
  return !hitsNegative;
}

function cachedIdentityMatches(record: ChatMessageRecord, target: string, identityCache?: IdentityCache): boolean {
  if (!identityCache) return false;
  const rawTarget = target.trim();
  const normalizedTarget = normalizeTargetText(rawTarget);
  if (!normalizedTarget) return false;

  const users = identityCache.users || {};
  const cached = users[getUserKey(record)] || (record.senderId ? users[record.senderId] : undefined);
  if (!cached) return false;

  const usernames = cached.usernames || [];
  const names = cached.names || [];
  if (rawTarget.startsWith("@")) {
    return usernames.some((username) => normalizeTargetText(username) === normalizedTarget);
  }
  if (/^\d+$/.test(normalizedTarget)) {
    return normalizeTargetText(cached.senderId) === normalizedTarget;
  }

  return [...names, ...usernames].some((value) => {
    const candidate = normalizeTargetText(value);
    return (
      candidate === normalizedTarget ||
      (normalizedTarget.length >= 2 && candidate.includes(normalizedTarget)) ||
      (candidate.length >= 2 && normalizedTarget.includes(candidate))
    );
  });
}

function recordMatchesTarget(record: ChatMessageRecord, target: string, identityCache?: IdentityCache): boolean {
  const rawTarget = target.trim();
  const normalizedTarget = normalizeTargetText(rawTarget);
  if (!normalizedTarget) return false;

  const username = normalizeTargetText(record.username);
  const senderId = normalizeTargetText(record.senderId);
  if (rawTarget.startsWith("@")) {
    return (Boolean(username) && username === normalizedTarget) || cachedIdentityMatches(record, target, identityCache);
  }
  if (/^\d+$/.test(normalizedTarget)) {
    return (Boolean(senderId) && senderId === normalizedTarget) || cachedIdentityMatches(record, target, identityCache);
  }

  const fullName = [record.firstName, record.lastName].filter(Boolean).join("");
  const candidates = [record.sender, record.firstName, record.lastName, fullName, record.username]
    .map((value) => normalizeTargetText(value))
    .filter(Boolean);

  return candidates.some(
    (candidate) =>
      candidate === normalizedTarget ||
      (normalizedTarget.length >= 2 && candidate.includes(normalizedTarget)) ||
      (candidate.length >= 2 && normalizedTarget.includes(candidate)),
  ) || cachedIdentityMatches(record, target, identityCache);
}

function buildPersonContextIndexes(total: number, matchedIndexes: number[], limit: number): number[] {
  if (!matchedIndexes.length) return [];

  for (const radius of [PERSON_CONTEXT_RADIUS, 1, 0]) {
    const matchLimit = Math.min(
      matchedIndexes.length,
      Math.max(20, Math.floor(limit / Math.max(1, radius * 2 + 1))),
    );
    const selectedMatches = matchedIndexes.length > matchLimit
      ? pickEvenValues(matchedIndexes, matchLimit)
      : matchedIndexes;
    const indexes = new Set<number>();
    for (const index of selectedMatches) {
      for (let contextIndex = Math.max(0, index - radius); contextIndex <= Math.min(total - 1, index + radius); contextIndex += 1) {
        indexes.add(contextIndex);
      }
    }
    if (indexes.size <= limit) return [...indexes].sort((a, b) => a - b);
  }

  return pickEvenValues(matchedIndexes, limit).sort((a, b) => a - b);
}

function preparePersonInput(records: ChatMessageRecord[], target: string, identityCache?: IdentityCache): PreparedInput {
  const matchedIndexes = records
    .map((record, index) => (recordMatchesTarget(record, target, identityCache) ? index : -1))
    .filter((index) => index >= 0);

  if (!matchedIndexes.length) {
    const sampled = sampleRecords(records, 100);
    return {
      lines: sampled.records.map((record) => recordToLine(record, { includeIdentity: true, maxContentChars: 180 })),
      note: `未找到与「${target}」匹配的发言；仅提供 ${sampled.records.length} 条全局采样上下文，无法确认时必须说明未找到精确匹配`,
    };
  }

  const contextIndexes = [...new Set([
    ...buildPersonContextIndexes(records.length, matchedIndexes, MAX_PERSON_CONTEXT_LINES),
    ...matchedIndexes,
  ])].sort((a, b) => a - b);
  const matchedIndexSet = new Set(matchedIndexes);
  let maxContentChars = 220;
  let selectedIndexes = contextIndexes;
  let lines = selectedIndexes.map((index) =>
    recordToLine(records[index], {
      mark: matchedIndexSet.has(index),
      includeIdentity: true,
      maxContentChars,
    }),
  );

  while (lines.join("\n").length > SUMMARY_MESSAGE_CHAR_BUDGET && maxContentChars > 100) {
    maxContentChars = Math.max(100, maxContentChars - 40);
    lines = selectedIndexes.map((index) =>
      recordToLine(records[index], {
        mark: matchedIndexSet.has(index),
        includeIdentity: true,
        maxContentChars,
      }),
    );
  }

  if (lines.join("\n").length > SUMMARY_MESSAGE_CHAR_BUDGET) {
    const targetLineCount = Math.max(80, Math.floor((selectedIndexes.length * SUMMARY_MESSAGE_CHAR_BUDGET) / lines.join("\n").length));
    const matchedContextIndexes = selectedIndexes.filter((index) => matchedIndexSet.has(index));
    const otherContextIndexes = selectedIndexes.filter((index) => !matchedIndexSet.has(index));
    const keptMatchedIndexes = matchedContextIndexes.length > targetLineCount
      ? pickEvenValues(matchedContextIndexes, targetLineCount)
      : matchedContextIndexes;
    const remaining = Math.max(0, targetLineCount - keptMatchedIndexes.length);
    selectedIndexes = [
      ...keptMatchedIndexes,
      ...pickEvenValues(otherContextIndexes, remaining),
    ].sort((a, b) => a - b);
    lines = selectedIndexes.map((index) =>
      recordToLine(records[index], {
        mark: matchedIndexSet.has(index),
        includeIdentity: true,
        maxContentChars,
      }),
    );
  }

  const compressionNote = selectedIndexes.length < contextIndexes.length
    ? `；输入过长，已压缩为 ${selectedIndexes.length} 条`
    : "";

  return {
    lines,
    note: `匹配到「${target}」本人发言 ${matchedIndexes.length} 条；输入包含 ${contextIndexes.length} 条上下文${compressionNote}，⭐ 标记分析对象本人`,
  };
}

function buildPersonLocalStats(
  records: ChatMessageRecord[],
  target: string,
  prepared: PreparedInput,
  identityCache?: IdentityCache,
): string[] {
  const sorted = sortRecords(records);
  const matched = sorted.filter((record) => recordMatchesTarget(record, target, identityCache));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const firstMatched = matched[0];
  const lastMatched = matched[matched.length - 1];
  const identities = new Map<string, ChatMessageRecord>();
  for (const record of matched) {
    identities.set(getUserKey(record), record);
  }
  const identityText = [...identities.values()]
    .slice(0, 3)
    .map((record) => {
      const parts = [record.sender];
      if (record.username) parts.push(`@${record.username}`);
      if (record.senderId) parts.push(`id:${record.senderId}`);
      return parts.join(" ");
    })
    .join("；") || "未找到精确匹配";

  return [
    "人物分析本地统计：",
    `统计口径：请求范围内全量 ${sorted.length} 条可读消息；聊天消息区是供模型分析的上下文输入。`,
    `请求范围实际消息时间：${first ? formatDate(new Date(first.timestamp * 1000)) : "未知"} 至 ${last ? formatDate(new Date(last.timestamp * 1000)) : "未知"}`,
    `分析对象：${target}；本人精确匹配发言：${matched.length} 条；上下文输入：${prepared.lines.length} 条`,
    `本人发言时间：${firstMatched ? formatDate(new Date(firstMatched.timestamp * 1000)) : "未找到"} 至 ${lastMatched ? formatDate(new Date(lastMatched.timestamp * 1000)) : "未找到"}`,
    `匹配身份：${identityText}`,
    `身份缓存：已启用 senderId / 历史昵称 / 历史 username 辅助匹配`,
  ];
}

function buildPersonTopicWords(records: ChatMessageRecord[], limit = 8): string {
  const counts = new Map<string, number>();
  for (const record of records) {
    const content = record.content.replace(URL_PATTERN, " ").replace(/\[[^\]]+\]/g, " ");
    const tokens = content.match(/[A-Za-z0-9._-]{2,}|[\u4e00-\u9fa5]{2,8}/g) || [];
    for (const token of tokens) {
      const normalized = token.toLowerCase();
      if (normalized.length < 2 || MEME_STOP_WORDS.has(normalized)) continue;
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word, count]) => `${word} ${count}`)
    .join("、") || "无明显高频词";
}

function buildPersonChangeStats(
  currentRecords: ChatMessageRecord[],
  previousRecords: ChatMessageRecord[] | null,
  target: string,
  currentScope: string,
  previousScope: string,
  identityCache?: IdentityCache,
): string[] {
  if (!previousRecords) {
    return [
      "人物近期变化：",
      "未提供对照时段；如果使用 day/24h 等时间范围，会自动对比前一段同等长度时间。",
    ];
  }

  const currentMatched = sortRecords(currentRecords).filter((record) => recordMatchesTarget(record, target, identityCache));
  const previousMatched = sortRecords(previousRecords).filter((record) => recordMatchesTarget(record, target, identityCache));
  const delta = currentMatched.length - previousMatched.length;
  const ratio = previousMatched.length > 0 ? (currentMatched.length / previousMatched.length).toFixed(1) : "";
  const activity = delta > 5
    ? `明显更活跃（+${delta} 条${ratio ? `，约 ${ratio} 倍` : ""}）`
    : delta < -5
    ? `明显更少发言（${delta} 条${ratio ? `，约 ${ratio} 倍` : ""}）`
    : `活跃度接近（变化 ${delta} 条）`;

  return [
    "人物近期变化：",
    `当前范围：${currentScope}；本人 ${currentMatched.length} 条；高频关注：${buildPersonTopicWords(currentMatched)}`,
    `对照范围：${previousScope || "前一段同等长度时间"}；本人 ${previousMatched.length} 条；高频关注：${buildPersonTopicWords(previousMatched)}`,
    `变化提示：${activity}；请结合聊天上下文判断关注点、语气和互动对象是否变化。`,
  ];
}

function extractUrls(text: string): string[] {
  return Array.from(text.matchAll(URL_PATTERN)).map((match) => match[0]);
}

function getUrlDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "unknown";
  }
}

function classifyUrlDomain(domain: string): string {
  if (/github\.com|gitlab\.com|bitbucket\.org/.test(domain)) return "代码 / GitHub";
  if (/youtube\.com|youtu\.be|bilibili\.com|vimeo\.com/.test(domain)) return "视频";
  if (/t\.me|telegram\.me|telegram\.org/.test(domain)) return "Telegram";
  if (/docs\.|notion\.site|notion\.so|gitbook\.io|readthedocs\.io|wikipedia\.org/.test(domain)) return "文档 / 知识库";
  if (/amazon\.|ebay\.|taobao\.|tmall\.|jd\.com|1688\.com|ovh\.|kimsufi\.|hetzner\.|netcup\.|cloudflare\.|aliyun\.|vultr\.|digitalocean\./.test(domain)) return "商家 / 服务";
  if (/x\.com|twitter\.com|reddit\.com|nodeseek\.com|lowendtalk\.com/.test(domain)) return "社区 / 讨论";
  if (/imgur\.com|postimg\.cc|ibb\.co|pixhost\.|image/.test(domain)) return "图片 / 媒体";
  return "其他";
}

function buildLinkDomainStats(linkRecords: Array<{ record: ChatMessageRecord; url: string }>): string[] {
  const groups = new Map<string, Map<string, { count: number; samples: string[] }>>();
  for (const item of linkRecords) {
    const domain = getUrlDomain(item.url);
    const category = classifyUrlDomain(domain);
    const domains = groups.get(category) || new Map<string, { count: number; samples: string[] }>();
    const stat = domains.get(domain) || { count: 0, samples: [] };
    stat.count += 1;
    if (stat.samples.length < 2) stat.samples.push(item.url);
    domains.set(domain, stat);
    groups.set(category, domains);
  }

  const lines = [...groups.entries()]
    .sort((a, b) => {
      const ac = [...a[1].values()].reduce((sum, item) => sum + item.count, 0);
      const bc = [...b[1].values()].reduce((sum, item) => sum + item.count, 0);
      return bc - ac;
    })
    .flatMap(([category, domains]) => {
      const domainText = [...domains.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 6)
        .map(([domain, stat]) => `${domain} ${stat.count} 个`)
        .join("；");
      return [`${category}：${domainText}`];
    });

  return ["本地域名归类：", ...(lines.length ? lines : ["无可归类链接"])];
}

function isQuestion(text: string): boolean {
  return /[?？]|怎么|如何|为啥|为什么|有没有|是不是|能不能|咋办/.test(text);
}

function buildRankStats(records: ChatMessageRecord[]): string[] {
  const stats = new Map<string, { sender: string; count: number; questions: number; links: number; chars: number }>();
  for (const record of records) {
    const key = record.senderId || record.username || record.sender;
    const item = stats.get(key) || { sender: record.sender, count: 0, questions: 0, links: 0, chars: 0 };
    item.count += 1;
    item.questions += isQuestion(record.content) ? 1 : 0;
    item.links += extractUrls(record.content).length;
    item.chars += record.content.length;
    stats.set(key, item);
  }

  const values = [...stats.values()];
  const topBy = (field: "count" | "questions" | "links" | "chars") =>
    values
      .filter((item) => item[field] > 0)
      .sort((a, b) => b[field] - a[field])
      .slice(0, 5)
      .map((item, index) => `${index + 1}. ${item.sender}: ${item[field]}`);

  return [
    "本地统计：",
    `发言人数：${values.length}`,
    "发言数 TOP：",
    ...(topBy("count").length ? topBy("count") : ["无"]),
    "提问数 TOP：",
    ...(topBy("questions").length ? topBy("questions") : ["无"]),
    "链接贡献 TOP：",
    ...(topBy("links").length ? topBy("links") : ["无"]),
  ];
}

function getUserKey(record: ChatMessageRecord): string {
  return record.senderId || record.username || record.sender;
}

function topUserStats(records: ChatMessageRecord[], limit = 5): Array<{ sender: string; count: number }> {
  const counts = new Map<string, { sender: string; count: number }>();
  for (const record of records) {
    const key = getUserKey(record);
    const item = counts.get(key) || { sender: record.sender, count: 0 };
    item.count += 1;
    counts.set(key, item);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00-${String((hour + 1) % 24).padStart(2, "0")}:00`;
}

function buildActiveHourStats(records: ChatMessageRecord[], limit = 4): string[] {
  const counts = new Map<number, number>();
  for (const record of records) {
    const hour = new Date(record.timestamp * 1000).getHours();
    counts.set(hour, (counts.get(hour) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([hour, count]) => `${hourLabel(hour)}：${count} 条`);
}

function buildLocalSummaryStats(records: ChatMessageRecord[], prepared: PreparedInput): string[] {
  const sorted = sortRecords(records);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const topUsers = topUserStats(sorted, 5);
  const activeHours = buildActiveHourStats(sorted, 4);
  const linkCount = sorted.reduce((sum, record) => sum + extractUrls(record.content).length, 0);
  const questionCount = sorted.reduce((sum, record) => sum + (isQuestion(record.content) ? 1 : 0), 0);

  return [
    "本地统计：",
    `统计口径：以下统计基于全量 ${sorted.length} 条可读消息；话题细节基于采样输入。`,
    `实际时间范围：${first ? formatDate(new Date(first.timestamp * 1000)) : "未知"} 至 ${last ? formatDate(new Date(last.timestamp * 1000)) : "未知"}`,
    `消息总量：${sorted.length} 条；采样输入：${prepared.lines.length} 条`,
    `活跃时段 TOP：${activeHours.length ? activeHours.join("；") : "无"}`,
    `核心用户 TOP：${topUsers.map((user) => `${user.sender} ${user.count} 条`).join("；") || "无"}`,
    `链接数：${linkCount}；疑问句/问题数：${questionCount}`,
    ...buildUserTitleHints(sorted),
  ];
}

function buildUserTitleHints(records: ChatMessageRecord[], limit = 5): string[] {
  const stats = new Map<string, { sender: string; count: number; questions: number; links: number; media: number; chars: number }>();
  for (const record of records) {
    const key = getUserKey(record);
    const item = stats.get(key) || { sender: record.sender, count: 0, questions: 0, links: 0, media: 0, chars: 0 };
    item.count += 1;
    item.questions += isQuestion(record.content) ? 1 : 0;
    item.links += extractUrls(record.content).length;
    item.media += record.content.includes("[媒体消息]") ? 1 : 0;
    item.chars += record.content.length;
    stats.set(key, item);
  }

  const hints = [...stats.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((item) => {
      const traits = [
        item.questions >= Math.max(2, item.count * 0.25) ? "提问多" : "",
        item.links > 0 ? `资源 ${item.links}` : "",
        item.media > 0 ? `媒体 ${item.media}` : "",
        item.chars / Math.max(1, item.count) > 60 ? "长消息" : "短句互动",
      ].filter(Boolean);
      return `${item.sender}：${traits.join(" / ") || "普通互动"}；称号应围绕真实话题生成，尽量稳定、不冒犯`;
    });

  return hints.length ? ["称号库提示：", ...hints] : [];
}

function buildMemeStats(records: ChatMessageRecord[]): string[] {
  const phraseCounts = new Map<string, { count: number; users: Set<string> }>();
  const shortLineCounts = new Map<string, { count: number; users: Set<string> }>();

  for (const record of records) {
    const content = record.content
      .replace(URL_PATTERN, " ")
      .replace(/\[[^\]]+\]/g, " ")
      .trim();
    if (!content) continue;

    if (content.length >= 2 && content.length <= 16 && !isQuestion(content)) {
      const item = shortLineCounts.get(content) || { count: 0, users: new Set<string>() };
      item.count += 1;
      item.users.add(record.sender);
      shortLineCounts.set(content, item);
    }

    const tokens = content.match(/[A-Za-z0-9._-]{2,}|[\u4e00-\u9fa5]{2,8}/g) || [];
    for (const token of tokens) {
      const normalized = token.toLowerCase();
      if (normalized.length < 2 || MEME_STOP_WORDS.has(normalized)) continue;
      const item = phraseCounts.get(token) || { count: 0, users: new Set<string>() };
      item.count += 1;
      item.users.add(record.sender);
      phraseCounts.set(token, item);
    }
  }

  const formatTop = (map: Map<string, { count: number; users: Set<string> }>, minCount: number) =>
    [...map.entries()]
      .filter(([, item]) => item.count >= minCount)
      .sort((a, b) => b[1].count - a[1].count || b[1].users.size - a[1].users.size)
      .slice(0, 12)
      .map(([text, item]) => `${text}：${item.count} 次｜用户：${[...item.users].slice(0, 4).join("、")}`);

  const repeatedLines = formatTop(shortLineCounts, 2);
  const hotWords = formatTop(phraseCounts, 3);
  return [
    "本地热词候选：",
    ...(hotWords.length ? hotWords : ["无明显高频热词"]),
    "重复短句候选：",
    ...(repeatedLines.length ? repeatedLines : ["无明显重复短句"]),
  ];
}

function buildRelationStats(records: ChatMessageRecord[]): string[] {
  const pairStats = new Map<string, { a: string; b: string; count: number }>();
  const mentions = new Map<string, { from: string; to: string; count: number }>();
  const usernameToSender = new Map<string, string>();

  for (const record of records) {
    if (record.username) usernameToSender.set(record.username.toLowerCase(), record.sender);
  }

  for (let index = 1; index < records.length; index += 1) {
    const prev = records[index - 1];
    const curr = records[index];
    if (getUserKey(prev) === getUserKey(curr)) continue;
    if (curr.timestamp - prev.timestamp > 10 * 60) continue;
    const names = [prev.sender, curr.sender].sort();
    const key = names.join(" ↔ ");
    const item = pairStats.get(key) || { a: names[0], b: names[1], count: 0 };
    item.count += 1;
    pairStats.set(key, item);
  }

  for (const record of records) {
    for (const match of record.content.matchAll(/@([A-Za-z0-9_]{3,})/g)) {
      const to = usernameToSender.get(match[1].toLowerCase()) || `@${match[1]}`;
      const key = `${record.sender}->${to}`;
      const item = mentions.get(key) || { from: record.sender, to, count: 0 };
      item.count += 1;
      mentions.set(key, item);
    }
  }

  const topPairs = [...pairStats.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
    .map((item) => `${item.a} ↔ ${item.b}：连续互动约 ${item.count} 次`);
  const topMentions = [...mentions.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)
    .map((item) => `${item.from} → ${item.to}：点名 ${item.count} 次`);

  return [
    "本地互动候选：",
    ...(topPairs.length ? topPairs : ["无明显连续互动候选"]),
    "本地点名候选：",
    ...(topMentions.length ? topMentions : ["无明显 @ 点名"]),
  ];
}

function buildQuoteCandidateLines(records: ChatMessageRecord[]): string[] {
  const candidates = records.filter((record) => {
    const text = record.content.trim();
    if (text.length < 4 || text.length > 90) return false;
    if (extractUrls(text).length) return false;
    if (text === "[媒体消息]") return false;
    return /[！!？?]|哈哈|笑死|离谱|牛|草|冲|富哥|绷|乐|绝了|麻了|炸了|跑路|上车/.test(text);
  });

  const picked = candidates.length > 120 ? pickEvenValues(candidates, 120) : candidates;
  return [
    "金句候选：",
    ...(picked.length
      ? picked.map((record) => recordToLine(record, { includeIdentity: true, maxContentChars: 120 }))
      : ["无明显金句候选，允许从代表性消息中谨慎挑选短句"]),
  ];
}

function prepareMemeInput(records: ChatMessageRecord[]): PreparedInput {
  const sampled = prepareSummaryInput(records);
  return {
    lines: [
      ...buildMemeStats(records),
      "",
      ...buildQuoteCandidateLines(records).slice(0, 80),
      "",
      "代表性消息：",
      ...sampled.lines.slice(0, 140),
    ],
    note: `已统计 ${records.length} 条消息的热词/重复短句，并提供代表性消息`,
  };
}

function prepareRoastInput(records: ChatMessageRecord[]): PreparedInput {
  const sampled = prepareSummaryInput(records);
  return {
    lines: [
      "吐槽边界：只吐槽群聊现象、话题走向、集体行为和名场面；不要做人身攻击。",
      "去重提示：主槽、槽点 TOP、名场面尽量选不同事件；同一用户不要刷屏。",
      "排版提示：槽点 TOP 必须使用“短标题｜人物：用户”格式，让人名和正文分开。",
      "",
      ...buildRankStats(records).slice(0, 10),
      "",
      ...buildMemeStats(records),
      "",
      ...buildQuoteCandidateLines(records).slice(0, 80),
      "",
      "代表性消息：",
      ...sampled.lines.slice(0, 140),
    ],
    note: "槽点候选已整理",
  };
}

function prepareRelationInput(records: ChatMessageRecord[]): PreparedInput {
  const sampled = prepareSummaryInput(records);
  return {
    lines: [
      ...buildRelationStats(records),
      "",
      ...buildRankStats(records),
      "",
      "代表性消息：",
      ...sampled.lines.slice(0, 150),
    ],
    note: `已统计 ${records.length} 条消息的连续互动和 @ 点名候选`,
  };
}

function prepareQuotesInput(records: ChatMessageRecord[]): PreparedInput {
  const quoteLines = buildQuoteCandidateLines(records);
  const sampled = prepareSummaryInput(records);
  return {
    lines: [
      ...quoteLines,
      "",
      "代表性消息：",
      ...sampled.lines.slice(0, 100),
    ],
    note: `已筛选 ${records.length} 条消息中的金句候选，并附带代表性上下文`,
  };
}

function prepareCompareInput(
  currentRecords: ChatMessageRecord[],
  previousRecords: ChatMessageRecord[],
  currentLabel: string,
  previousLabel: string,
): PreparedInput {
  const currentPrepared = currentRecords.length >= 520 ? prepareSegmentedSummaryInput(currentRecords) : prepareFlatSummaryInput(currentRecords);
  const previousPrepared = previousRecords.length >= 520 ? prepareSegmentedSummaryInput(previousRecords) : prepareFlatSummaryInput(previousRecords);
  const currentLines = compactLinesToBudget(currentPrepared.lines, 9000);
  const previousLines = compactLinesToBudget(previousPrepared.lines, 9000);
  return {
    lines: [
      "对比本地统计：",
      `当前时段：${currentLabel}；全量 ${currentRecords.length} 条；采样 ${currentPrepared.lines.length} 条`,
      ...buildLocalSummaryStats(currentRecords, currentPrepared).slice(2),
      "",
      `对照时段：${previousLabel}；全量 ${previousRecords.length} 条；采样 ${previousPrepared.lines.length} 条`,
      ...buildLocalSummaryStats(previousRecords, previousPrepared).slice(2),
      "",
      "当前时段聊天消息：",
      ...currentLines,
      "",
      "对照时段聊天消息：",
      ...previousLines,
    ],
    note: `已对比当前 ${currentRecords.length} 条和对照 ${previousRecords.length} 条消息；两边分别独立采样/分段并各自限制输入预算`,
  };
}

function prepareRankInput(records: ChatMessageRecord[]): PreparedInput {
  const sampled = prepareSummaryInput(records);
  return {
    lines: [
      ...buildRankStats(records),
      ...buildUserTitleHints(records),
      "",
      "代表性消息：",
      ...sampled.lines.slice(0, 140),
    ],
    note: `已统计 ${records.length} 条消息，并提供代表性消息辅助判断称号和贡献方式`,
  };
}

function prepareLinksInput(records: ChatMessageRecord[]): PreparedInput {
  const linkLines: string[] = [];
  const linkRecords: Array<{ record: ChatMessageRecord; url: string }> = [];
  const seen = new Set<string>();
  for (const record of records) {
    for (const url of extractUrls(record.content)) {
      const normalized = url.replace(/[),.;，。；]+$/, "");
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      linkRecords.push({ record, url: normalized });
      linkLines.push(recordToLine({ ...record, content: normalized }, { maxContentChars: 500 }));
      if (linkLines.length >= 120) break;
    }
    if (linkLines.length >= 120) break;
  }

  if (!linkLines.length) {
    return {
      lines: ["这段时间没有提取到 http/https 链接。", ...prepareSummaryInput(records).lines.slice(0, 80)],
      note: `未发现链接；提供 ${Math.min(80, records.length)} 条上下文供模型说明没有资源沉淀`,
    };
  }

  return {
    lines: [
      ...buildLinkDomainStats(linkRecords),
      "",
      "去重链接明细：",
      ...linkLines,
    ],
    note: `提取到 ${seen.size} 个去重链接，已按域名归类并输入前 ${linkLines.length} 个明细`,
  };
}

function prepareKeywordInput(records: ChatMessageRecord[], keyword: string): PreparedInput {
  const query = parseKeywordQuery(keyword);
  const matchedIndexes = records
    .map((record, index) => (recordMatchesKeywordQuery(record, query) ? index : -1))
    .filter((index) => index >= 0);

  if (!matchedIndexes.length) {
    const sampled = sampleRecords(records, 100);
    return {
      lines: [
        `未直接找到关键词「${keyword}」。`,
        `关键词规则：${query.label}`,
        ...sampled.records.map((record) => recordToLine(record, { maxContentChars: 180 })),
      ],
      note: `未找到关键词「${keyword}」的直接匹配；${query.label}；仅提供全局采样上下文`,
    };
  }

  const indexes = buildPersonContextIndexes(records.length, matchedIndexes, 180);
  const matchedIndexSet = new Set(matchedIndexes);
  return {
    lines: [
      `关键词规则：${query.label}`,
      ...indexes.map((index) =>
        recordToLine(records[index], {
          mark: matchedIndexSet.has(index),
          includeIdentity: true,
          maxContentChars: 220,
        }),
      ),
    ],
    note: `关键词「${keyword}」匹配 ${matchedIndexes.length} 条；${query.label}；⭐ 标记直接命中的消息，并附带上下文`,
  };
}

function prepareSpecialInput(mode: SumMode, records: ChatMessageRecord[], keyword?: string): PreparedInput {
  if (mode === "rank") return prepareRankInput(records);
  if (mode === "links") return prepareLinksInput(records);
  if (mode === "about") return prepareKeywordInput(records, keyword || "");
  if (mode === "meme") return prepareMemeInput(records);
  if (mode === "roast") return prepareRoastInput(records);
  if (mode === "relation") return prepareRelationInput(records);
  if (mode === "quotes") return prepareQuotesInput(records);
  return prepareSummaryInput(records);
}

function buildModePrompt(mode: SumMode, chatName: string, keyword?: string): string {
  if (mode === "summary") return `${unifiedSummaryPrompt}${templatePolishPrompt}`;
  if (mode === "person") return `${personAnalysisPrompt}${templatePolishPrompt}`;
  const prompt = modePrompts[mode];
  if (mode === "about") {
    return `${prompt}${templatePolishPrompt}\n\n关键词：${keyword || ""}\n群名：${chatName}`;
  }
  return `${prompt}${templatePolishPrompt}\n\n群名：${chatName}`;
}

async function callOpenAI(config: SumConfig, messages: string): Promise<string> {
  const data = await postJsonWithCurl(
    openAIChatCompletionsUrl(config.baseUrl),
    config.apiKey,
    {
      model: config.model,
      messages: [
        { role: "system", content: config.prompt },
        { role: "user", content: compactSummaryInput(messages) },
      ],
      temperature: 0.2,
      max_tokens: Math.max(256, Math.min(5200, config.maxOutputLength || 1200)),
      stream: Boolean(config.stream),
    },
  );

  const content = data?.choices?.[0]?.message?.content;
  if (!content || typeof content !== "string") {
    throw new Error("OpenAI 兼容接口返回空结果");
  }
  return content.trim();
}

async function callGemini(config: SumConfig, messages: string): Promise<string> {
  const response = await axios.post(
    `${trimTrailingSlash(config.baseUrl)}/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`,
    {
      contents: [
        {
          role: "user",
          parts: [{ text: `${config.prompt}\n\n${messages}` }],
        },
      ],
    },
    {
      headers: { "Content-Type": "application/json" },
      timeout: 60000,
    },
  );

  const content = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content || typeof content !== "string") {
    throw new Error("Gemini 接口返回空结果");
  }
  return content.trim();
}

async function summarize(config: SumConfig, messages: string): Promise<SummaryResult> {
  const providers = [
    {
      name: config.name || "主线路",
      type: config.type,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      stream: config.stream,
    },
    ...(config.fallbacks || []),
  ];
  const errors: string[] = [];

  if (!providers.some((provider) => provider.apiKey)) {
    throw new Error(`请先配置 API Key：${mainPrefix}sum key YOUR_API_KEY`);
  }

  for (const provider of providers) {
    if (!provider.apiKey) continue;

    try {
      const providerConfig = {
        ...config,
        ...provider,
        type: provider.type || config.type,
      } as SumConfig;
      const result =
        providerConfig.type === "gemini"
          ? await callGemini(providerConfig, messages)
          : await callOpenAI(providerConfig, messages);

      let content = stripThinking(result);
      if (config.maxOutputLength > 0 && content.length > config.maxOutputLength) {
        content =
          content.slice(0, config.maxOutputLength) +
          "\n\n内容已截断：超过最大输出长度。";
      }
      return {
        content,
        provider: {
          name: provider.name || provider.baseUrl,
          type: providerConfig.type,
          baseUrl: provider.baseUrl,
          model: provider.model,
        },
      };
    } catch (error: any) {
      const name = provider.name || provider.baseUrl;
      const message = error?.response?.data?.error?.message || error?.message || String(error);
      errors.push(`${name}: ${message}`);
    }
  }

  throw new Error(`所有接口都失败：${errors.join("；")}`);
}

function providerFooter(provider: ProviderUseInfo, meta: FooterMeta): string {
  const compareText = meta.comparePreviousResult
    ? `｜对照 ${meta.comparePreviousResult.records.length} 条`
    : "";
  const limitText = meta.fetchResult.reachedFetchLimit ? "｜已触发抓取上限" : "";
  const inputNote = meta.prepared.note
    .replace(/^完整输入\s+\d+\s+条可读消息$/, "完整输入")
    .replace(/^原始\s+\d+\s+条[，,]\s*/, "")
    .replace(/^分段\s+\d+\s+段/, "已做长消息整理")
    .replace(/^已统计\s+\d+\s+条消息的/, "已整理")
    .replace(/^已筛选\s+\d+\s+条消息中的/, "已筛选")
    .replace(/；每段保留统计和代表性消息/g, "")
    .replace(/，并按预算压缩/g, "，已压缩");
  return [
    "",
    "---",
    `🤖 模型：${provider.name}｜${provider.model}`,
    `📥 输入：${meta.fetchResult.records.length} 条${compareText}｜${inputNote}${limitText}`,
  ].join("\n");
}

function providerChainLines(config: SumConfig): string[] {
  const providers = [
    {
      name: config.name || "主线路",
      type: config.type,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      stream: config.stream,
    },
    ...(config.fallbacks || []).map((provider) => ({
      ...provider,
      type: provider.type || config.type,
    })),
  ];

  return providers.map((provider, index) =>
    `${index + 1}. ${provider.name || provider.baseUrl}｜${provider.model}｜${provider.type}｜${provider.apiKey ? "已配置" : "未配置"}`,
  );
}

function buildDebugText(params: {
  config: SumConfig;
  rangeLabel: string;
  fetchResult: MessageFetchResult;
  prepared: PreparedInput;
  target?: string;
  keyword?: string;
  identityCache?: IdentityCache;
}): string {
  const sorted = sortRecords(params.fetchResult.records);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const matchedTarget = params.target
    ? sorted.filter((record) => recordMatchesTarget(record, params.target || "", params.identityCache)).length
    : null;
  const matchedKeyword = params.keyword
    ? sorted.filter((record) => recordMatchesKeywordQuery(record, parseKeywordQuery(params.keyword || ""))).length
    : null;
  const topUsers = topUserStats(sorted, 5).map((user) => `${user.sender} ${user.count}`).join(" / ") || "无";
  const activeHours = buildActiveHourStats(sorted, 3).join(" / ") || "无";
  const providerChain = providerChainLines(params.config)
    .map((line) => line.replace(/^\d+\.\s*/, "").replace("｜已配置", "").replace("｜未配置", "｜未配置 key"))
    .join(" -> ");

  return [
    "🧪 Sum 诊断",
    "",
    `📆 范围：${params.rangeLabel}`,
    `🕒 实际：${first ? formatDate(new Date(first.timestamp * 1000)) : "无"} 至 ${last ? formatDate(new Date(last.timestamp * 1000)) : "无"}`,
    `📥 抓取：${params.fetchResult.fetchedPages} 页 / ${sorted.length} 条`,
    `🧩 输入：${params.prepared.lines.length} 行 / ${params.prepared.lines.join("\n").length} 字｜${params.prepared.note}`,
    `✅ 状态：${params.fetchResult.reachedTimeBoundary ? "已覆盖请求范围" : "未确认到底"}｜${params.fetchResult.reachedFetchLimit ? "已触发抓取上限" : "未触发上限"}`,
    params.target ? `👤 人物匹配：${params.target} => ${matchedTarget} 条` : "",
    params.keyword ? `🔎 关键词匹配：${params.keyword} => ${matchedKeyword} 条` : "",
    "",
    `👥 核心用户：${topUsers}`,
    `📈 活跃时段：${activeHours}`,
    "",
    `🔌 线路：${providerChain}`,
  ].filter((line) => line !== "").join("\n");
}

async function handleCommand(msg: Api.Message): Promise<void> {
  const raw = msg.message || "";
  const parts = raw.trim().split(/\s+/);
  const [, sub, ...args] = parts;
  const db = await getDB();

  try {
    if (sub === "key") {
      const apiKey = args.join(" ").trim();
      if (!apiKey) {
        await msg.edit({ text: "请提供 API Key" });
        return;
      }
      db.data.apiKey = apiKey;
      await db.write();
      await msg.edit({ text: "✅ API Key 已保存" });
      return;
    }

    if (sub === "url") {
      const url = args[0]?.trim();
      if (!url || !/^https?:\/\//i.test(url)) {
        await msg.edit({ text: "请提供有效 Base URL，例如 https://api.openai.com" });
        return;
      }
      db.data.baseUrl = trimTrailingSlash(url);
      await db.write();
      await msg.edit({ text: `✅ Base URL 已设置为 ${codeTag(db.data.baseUrl)}`, parseMode: "html" });
      return;
    }

    if (sub === "model") {
      const model = args.join(" ").trim();
      if (!model) {
        await msg.edit({ text: "请提供模型名" });
        return;
      }
      db.data.model = model;
      await db.write();
      await msg.edit({ text: `✅ 模型已设置为 ${codeTag(model)}`, parseMode: "html" });
      return;
    }

    if (sub === "type") {
      const type = args[0]?.toLowerCase();
      if (type !== "openai" && type !== "gemini") {
        await msg.edit({ text: "类型只能是 openai 或 gemini" });
        return;
      }
      db.data.type = type;
      if (type === "gemini" && db.data.baseUrl === defaultConfig.baseUrl) {
        db.data.baseUrl = "https://generativelanguage.googleapis.com";
        db.data.model = "gemini-2.0-flash";
      }
      await db.write();
      await msg.edit({ text: `✅ 接口类型已设置为 ${codeTag(type)}`, parseMode: "html" });
      return;
    }

    if (sub === "prompt") {
      const prompt = args.join(" ").trim();
      if (!prompt) {
        await msg.edit({ text: codeTag(db.data.prompt), parseMode: "html" });
        return;
      }
      db.data.prompt = prompt === "reset" ? defaultConfig.prompt : prompt;
      await db.write();
      await msg.edit({ text: "✅ 提示词已更新" });
      return;
    }

    if (sub === "max") {
      const n = Number(args[0]);
      if (!Number.isFinite(n) || n < 0) {
        await msg.edit({ text: "请输入非负数字，0 表示不限制" });
        return;
      }
      db.data.maxOutputLength = Math.trunc(n);
      await db.write();
      await msg.edit({ text: `✅ 最大输出已设置为 ${db.data.maxOutputLength || "不限制"}` });
      return;
    }

    if (sub === "reply") {
      const value = args[0]?.toLowerCase();
      if (value !== "on" && value !== "off") {
        await msg.edit({ text: "用法：sum reply on/off" });
        return;
      }
      db.data.replyMode = value === "on";
      await db.write();
      await msg.edit({ text: `✅ 回复模式已${db.data.replyMode ? "开启" : "关闭"}` });
      return;
    }

    if (sub === "info") {
      const lines = [
        "📌 聊天摘要配置",
        `类型: ${codeTag(db.data.type)}`,
        `Base URL: ${codeTag(db.data.baseUrl)}`,
        `模型: ${codeTag(db.data.model)}`,
        `API Key: ${db.data.apiKey ? "已设置" : "未设置"}`,
        `流式请求: ${db.data.stream ? "开启" : "关闭"}`,
        `备用线路: ${(db.data.fallbacks || []).length}`,
        "供应商链路:",
        ...providerChainLines(db.data).map((line) => htmlEscape(line)),
        `最大输出: ${db.data.maxOutputLength || "不限制"}`,
        `回复模式: ${db.data.replyMode ? "开启" : "关闭"}`,
      ];
      await msg.edit({ text: lines.join("\n"), parseMode: "html" });
      return;
    }

    if (sub === "help") {
      await msg.edit({ text: helpText, parseMode: "html" });
      return;
    }

    if (sub === "menu" || sub === "modes" || sub === "玩法" || sub === "菜单") {
      await msg.edit({ text: menuText, parseMode: "html" });
      return;
    }

    if (sub === "debug" || sub === "stat" || sub === "stats" || sub === "诊断") {
      const debugArgs = [...args];
      let debugKeyword = "";
      let request: { rangeToken: string | undefined; target: string };
      if (debugArgs[0] === "about" || debugArgs[0] === "topic" || debugArgs[0] === "关键词") {
        const parsed = parseRangeAndRest(debugArgs.slice(1), "24h");
        debugKeyword = parsed.rest.join(" ").trim();
        request = { rangeToken: parsed.rangeToken, target: "" };
      } else {
        request = parseSummaryRequest(debugArgs[0], debugArgs.slice(1));
      }
      const range = resolveRangeToken(request.rangeToken);
      const chatId = String(msg.chatId);
      await msg.edit({ text: "⏳ 正在读取消息并生成调试统计..." });
      const fetchResult = range.startTime && range.endTime
        ? await getChatMessageRecordsByTimeRange(chatId, range.startTime, range.endTime)
        : await getChatMessageRecords(chatId, range.count || 100);
      const identityCache = await updateIdentityCache(fetchResult.records);
      const prepared = request.target
        ? preparePersonInput(fetchResult.records, request.target, identityCache)
        : debugKeyword
        ? prepareKeywordInput(fetchResult.records, debugKeyword)
        : prepareSummaryInput(fetchResult.records);
      const fetchNote = range.startTime && range.endTime
        ? `${range.label}，已读取 ${fetchResult.fetchedPages} 页 / ${fetchResult.records.length} 条可读消息`
        : `最近 ${fetchResult.records.length} 条可读消息`;
      const text = buildDebugText({
        config: db.data,
        rangeLabel: fetchNote,
        fetchResult,
        prepared,
        target: request.target,
        keyword: debugKeyword,
        identityCache,
      });
      const parts = withPartHeader(splitLongText(text));
      await msg.edit({ text: parts[0] });
      const client = await getGlobalClient();
      if (!client) throw new Error("Telegram 客户端未初始化");
      for (const part of parts.slice(1)) {
        await client.sendMessage(chatId, { message: part });
      }
      return;
    }

    const special = parseSpecialRequest(sub, args);
    const request = special
      ? { rangeToken: special.rangeToken, target: special.target || "" }
      : parseSummaryRequest(sub, args);
    const range = resolveRangeToken(request.rangeToken);
    const chatId = String(msg.chatId);

    await msg.edit({ text: "⏳ 正在读取消息并生成摘要..." });

    const mode: SumMode = special?.mode || (request.target ? "person" : "summary");
    const isPersonAnalysis = mode === "person";
    const isCompareMode = mode === "compare";
    const effectiveRange = isCompareMode && (!range.startTime || !range.endTime)
      ? resolveRangeToken("day")
      : range;
    const fetchResult = effectiveRange.startTime && effectiveRange.endTime
      ? await getChatMessageRecordsByTimeRange(chatId, effectiveRange.startTime, effectiveRange.endTime)
      : await getChatMessageRecords(chatId, effectiveRange.count || 100);
    let comparePreviousResult: MessageFetchResult | null = null;
    let previousScope = "";

    if ((isCompareMode || isPersonAnalysis) && effectiveRange.startTime && effectiveRange.endTime) {
      const spanSeconds = Math.max(60, effectiveRange.endTime - effectiveRange.startTime + 1);
      const previousEnd = effectiveRange.startTime - 1;
      const previousStart = previousEnd - spanSeconds + 1;
      comparePreviousResult = await getChatMessageRecordsByTimeRange(chatId, previousStart, previousEnd);
      previousScope = `${formatDate(new Date(previousStart * 1000))} 至 ${formatDate(new Date(previousEnd * 1000))}`;
    }

    if (fetchResult.records.length === 0 && (!comparePreviousResult || comparePreviousResult.records.length === 0)) {
      await msg.edit({ text: "没有找到可总结的文本消息" });
      return;
    }
    const identityCache = await updateIdentityCache([
      ...fetchResult.records,
      ...(comparePreviousResult?.records || []),
    ]);

    const chatName = getChatDisplayName(msg, chatId);
    const density = getSummaryDensity(effectiveRange.durationMinutes, fetchResult.records.length);
    const volumeMode = fetchResult.records.length < 30
      ? "短消息模式：内容少时不要硬凑栏目，每栏只写确有依据的内容。"
      : fetchResult.records.length >= 520
      ? "长消息模式：先按时间理解主线，再输出全局结论。"
      : "标准模式：兼顾本地统计和代表性消息。";
    const topicIndexEnabled = !isPersonAnalysis && mode === "summary" && Boolean(
      effectiveRange.durationMinutes && (effectiveRange.durationMinutes >= 360 || fetchResult.records.length >= 500),
    );
    const fetchNote = effectiveRange.startTime && effectiveRange.endTime
      ? [
          `已读取 ${fetchResult.fetchedPages} 页 / ${fetchResult.records.length} 条可读消息`,
          fetchResult.reachedFetchLimit
            ? `已达到抓取上限：最多 ${MAX_DURATION_FETCH_PAGES} 页或 ${MAX_DURATION_FETCH_MESSAGES} 条，摘要输入已采样`
            : "已覆盖请求时间范围",
        ].join("；")
      : `已读取最近 ${fetchResult.records.length} 条可读消息`;
    const scope = effectiveRange.startTime && effectiveRange.endTime
      ? `${effectiveRange.label}，${fetchNote}`
      : `最近 ${fetchResult.records.length} 条可读消息`;
    const prepared = isPersonAnalysis
      ? preparePersonInput(fetchResult.records, request.target, identityCache)
      : isCompareMode && comparePreviousResult
      ? prepareCompareInput(fetchResult.records, comparePreviousResult.records, scope, previousScope)
      : special
      ? prepareSpecialInput(mode, fetchResult.records, special.keyword)
      : prepareSummaryInput(fetchResult.records);
    const localSummaryStats = !isPersonAnalysis && !["rank", "links", "about", "compare"].includes(mode)
      ? buildLocalSummaryStats(fetchResult.records, prepared)
      : [];
    const summaryInput = isPersonAnalysis
      ? [
          "模式：指定人物分析",
          `分析对象：${request.target}`,
          `时间范围：${scope}`,
          `群名：${chatName}`,
          `输入处理：${prepared.note}`,
          `输出模式：${volumeMode}`,
          `生成时间：${formatDate(new Date())}`,
          "",
          ...buildPersonLocalStats(fetchResult.records, request.target, prepared, identityCache),
          "",
          ...buildPersonChangeStats(
            fetchResult.records,
            comparePreviousResult?.records || null,
            request.target,
            scope,
            previousScope,
            identityCache,
          ),
          "",
          "聊天消息：",
          prepared.lines.join("\n"),
        ].join("\n")
      : [
          `摘要模式：${special ? special.title : "统一模板"}`,
          `摘要范围：${scope}`,
          previousScope ? `对照范围：${previousScope}` : "",
          `群名：${chatName}`,
          special?.keyword ? `关键词：${special.keyword}` : "",
          `输入处理：${prepared.note}`,
          `输出模式：${volumeMode}`,
          topicIndexEnabled ? "话题索引：启用，先列 5-6 个话题标题和极短说明，再展开重点话题。" : "",
          `摘要密度：${density.label}`,
          `总字数目标：${density.targetLength}`,
          `重点话题上限：${density.topicLimit}`,
          `每个话题要点上限：${density.pointLimit}`,
          `亮点上限：${density.highlightLimit}`,
          `金句上限：${density.quoteLimit}`,
          `待办上限：${density.todoLimit}`,
          `生成时间：${formatDate(new Date())}`,
          "",
          ...localSummaryStats,
          localSummaryStats.length ? "" : "",
          "聊天消息：",
          prepared.lines.join("\n"),
        ].filter((line) => line !== "").join("\n");
    const summaryConfig: SumConfig = {
      ...db.data,
      prompt: isPersonAnalysis
        ? `${personAnalysisPrompt}${templatePolishPrompt}`
        : special
        ? buildModePrompt(mode, chatName, special.keyword)
        : buildSystemPrompt(db.data.prompt),
      maxOutputLength: isPersonAnalysis
        ? 1100
        : special
        ? Math.max(db.data.maxOutputLength || 0, 1800)
        : Math.max(db.data.maxOutputLength || 0, density.maxOutputLength),
    };
    const summaryResult = await summarize(summaryConfig, summaryInput);
    const rawContent = `${summaryResult.content}${providerFooter(summaryResult.provider, {
      fetchResult,
      prepared,
      comparePreviousResult,
    })}`;
    const mentionLinks = buildSilentMentionLinks(fetchResult.records);
    const result = isPersonAnalysis
      ? formatMarkdownForTelegram(rawContent, mentionLinks)
      : special
      ? formatMarkdownForTelegram(rawContent, mentionLinks)
      : formatSummaryForTelegram(rawContent, chatName, mentionLinks);

    if (db.data.replyMode) {
      const client = await getGlobalClient();
      if (!client) throw new Error("Telegram 客户端未初始化");
      for (const part of withPartHeader(splitLongText(result))) {
        await client.sendMessage(chatId, { message: part, parseMode: "html" });
      }
      await msg.delete({ revoke: true });
      return;
    }

    const parts = withPartHeader(splitLongText(result));
    await msg.edit({ text: parts[0], parseMode: "html" });
    const client = await getGlobalClient();
    if (!client) throw new Error("Telegram 客户端未初始化");
    for (const part of parts.slice(1)) {
      await client.sendMessage(chatId, { message: part, parseMode: "html" });
    }
  } catch (error: any) {
    const message = error?.response?.data?.error?.message || error?.message || String(error);
    await msg.edit({ text: `❌ 摘要失败：${htmlEscape(message)}`, parseMode: "html" });
  }
}

const menuText = `▎Sum 摘要菜单

不用记命令，记住 <code>${mainPrefix}sum menu</code> 就行。

<b>日常补课</b>
<code>${mainPrefix}sum</code> - 最近 100 条普通摘要
<code>${mainPrefix}sum catchup 8h</code> - 像朋友一样补课
<code>${mainPrefix}sum day</code> - 今天日报
<code>${mainPrefix}sum yesterday</code> - 昨天日报
<code>${mainPrefix}sum week</code> - 本周周报

<b>好玩模式</b>
<code>${mainPrefix}sum hot 6h</code> - 争议 / 吵架雷达
<code>${mainPrefix}sum rank 24h</code> - 贡献榜 / 话唠榜
<code>${mainPrefix}sum vibe 12h</code> - 群聊气氛小剧场
<code>${mainPrefix}sum meme 24h</code> - 热梗榜 / 名场面
<code>${mainPrefix}sum melon 24h</code> - 吃瓜速报
<code>${mainPrefix}sum quotes 24h</code> - 金句收藏夹
<code>${mainPrefix}sum roast 24h</code> - 温和吐槽 / 槽点日报

<b>实用整理</b>
<code>${mainPrefix}sum links 24h</code> - 链接和资源整理
<code>${mainPrefix}sum todo 12h</code> - 待办和未解决问题
<code>${mainPrefix}sum about AI 24h</code> - 只看某个关键词
<code>${mainPrefix}sum about AI,Claude -Gemini 24h</code> - 多关键词 / 排除词
<code>${mainPrefix}sum map 24h</code> - 人物关系网
<code>${mainPrefix}sum story day</code> - 今日剧情线
<code>${mainPrefix}sum compare day</code> - 今天 vs 昨天
<code>${mainPrefix}sum track 24h</code> - 延续争议追踪

<b>人物分析</b>
<code>${mainPrefix}sum 6h @username</code>
<code>${mainPrefix}sum user 200 张三</code>

<b>排错诊断</b>
<code>${mainPrefix}sum debug 24h</code> - 查看抓取量 / 采样 / 线路
<code>${mainPrefix}sum debug 12h @username</code> - 查看人物匹配条数

中文也能用：<code>热梗</code>、<code>吃瓜</code>、<code>吐槽</code>、<code>槽点</code>、<code>金句</code>、<code>关系</code>、<code>剧情</code>、<code>对比</code>、<code>追踪</code>。
时间可以写：<code>30m</code>、<code>6h</code>、<code>24h</code>、<code>day</code>、<code>week</code>。`;

const helpText = `▎聊天摘要

只需要记住：<code>${mainPrefix}sum menu</code>

<b>摘要命令：</b>
<code>${mainPrefix}sum</code> - 总结当前聊天最近 100 条消息
<code>${mainPrefix}sum 200</code> - 总结当前聊天最近 200 条消息
<code>${mainPrefix}sum 5h</code> - 总结最近 5 小时消息
<code>${mainPrefix}sum 30m</code> - 总结最近 30 分钟消息
<code>${mainPrefix}sum menu</code> - 查看所有玩法
<code>${mainPrefix}sum 6h @username</code> - 分析指定用户的人物表现
<code>${mainPrefix}sum user 200 张三</code> - 分析最近 200 条里的张三
<code>${mainPrefix}sum meme 24h</code> - 热梗榜
<code>${mainPrefix}sum map 24h</code> - 人物关系网
<code>${mainPrefix}sum compare day</code> - 今天 vs 昨天
<code>${mainPrefix}sum quotes 24h</code> - 金句收藏夹
<code>${mainPrefix}sum roast 24h</code> - 温和吐槽 / 槽点日报
<code>${mainPrefix}sum debug 24h</code> - 只看抓取/采样/线路诊断，不调用模型

长时间范围会自动分页抓取并按时间分段；人物分析会优先精确匹配 @用户名 / 用户ID / 昵称，并使用历史身份缓存辅助匹配。

<b>配置命令：</b>
<code>${mainPrefix}sum key &lt;API_KEY&gt;</code>
<code>${mainPrefix}sum type openai|gemini</code>
<code>${mainPrefix}sum url &lt;BaseURL&gt;</code>
<code>${mainPrefix}sum model &lt;模型名&gt;</code>
<code>${mainPrefix}sum prompt &lt;提示词&gt;</code>
<code>${mainPrefix}sum prompt reset</code>
<code>${mainPrefix}sum max &lt;字符数&gt;</code>
<code>${mainPrefix}sum reply on/off</code>
<code>${mainPrefix}sum info</code>`;

class SumPlugin extends Plugin {
  description: string = helpText;

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    sum: handleCommand,
    summary: handleCommand,
  };
}

export default new SumPlugin();

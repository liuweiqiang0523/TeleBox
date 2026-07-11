import type { ChatMessageRecord, IdentityCache, PreparedInput, SumMode } from "./sumplus.types";

const MAX_MESSAGE_CHARS = 800;
const MAX_SUMMARY_SAMPLE_LINES = 160;
const MAX_PERSON_CONTEXT_LINES = 220;
const SUMMARY_MESSAGE_CHAR_BUDGET = 18000;
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

export function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

export function compactText(value: string, maxChars = MAX_MESSAGE_CHARS): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…[已截断${text.length - maxChars}字]`;
}

export function sortRecords(records: ChatMessageRecord[]): ChatMessageRecord[] {
  return [...records].sort((a, b) => a.timestamp - b.timestamp || a.id - b.id);
}

export function recordToLine(
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

export function addUnique(values: string[], value: string, limit = 8): string[] {
  const text = value.trim();
  if (!text) return values;
  const exists = values.some((item) => normalizeTargetText(item) === normalizeTargetText(text));
  if (exists) return values;
  return [...values, text].slice(-limit);
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
  let maxContentChars = 140;
  let sampled = sampleRecords(records, maxLines);
  let lines = sampled.records.map((record) => recordToLine(record, { maxContentChars }));

  while (lines.join("\n").length > SUMMARY_MESSAGE_CHAR_BUDGET && maxLines > 70) {
    maxLines = Math.max(70, Math.floor(maxLines * 0.75));
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

export function prepareSummaryInput(records: ChatMessageRecord[]): PreparedInput {
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

export function parseKeywordQuery(keyword: string): { positives: string[]; negatives: string[]; label: string } {
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

export function recordMatchesKeywordQuery(record: ChatMessageRecord, query: { positives: string[]; negatives: string[] }): boolean {
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

export function recordMatchesTarget(record: ChatMessageRecord, target: string, identityCache?: IdentityCache): boolean {
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

export function preparePersonInput(records: ChatMessageRecord[], target: string, identityCache?: IdentityCache): PreparedInput {
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

export function buildPersonLocalStats(
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

export function buildPersonChangeStats(
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

export function extractUrls(text: string): string[] {
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

export function getUserKey(record: ChatMessageRecord): string {
  return record.senderId || record.username || record.sender;
}

export function topUserStats(records: ChatMessageRecord[], limit = 5): Array<{ sender: string; count: number }> {
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

export function buildActiveHourStats(records: ChatMessageRecord[], limit = 4): string[] {
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

export function buildLocalSummaryStats(records: ChatMessageRecord[], prepared: PreparedInput): string[] {
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
    ...buildRepeatStats(sorted, 6),
    ...buildUserTitleHints(sorted),
    "",
    "全量复读/热词统计：以下候选基于全量消息，不是采样；如果出现高频复读、刷屏、口头禅或集体跟风，摘要必须写进重点话题、亮点或名场面，不能因为它是重复短句就忽略。",
    ...buildMemeStats(sorted),
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
      return `${item.sender}：${traits.join(" / ") || "普通互动"}；称号要围绕真实话题生成，可以更狠更有梗，但只吐槽发言风格/群聊角色，不做人身攻击`;
    });

  return hints.length ? ["称号库提示：", ...hints] : [];
}

function normalizeRepeatContent(content: string): string {
  const text = content
    .replace(URL_PATTERN, " ")
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || text.length < 2 || text.length > 40) return "";
  if (isQuestion(text)) return "";
  if (/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u.test(text)) return "";
  return text;
}

function buildRepeatStats(records: ChatMessageRecord[], limit = 6): string[] {
  const counts = new Map<string, { text: string; count: number; users: Set<string>; first: number; last: number }>();
  for (const record of records) {
    const text = normalizeRepeatContent(record.content);
    if (!text) continue;
    const key = text.toLowerCase();
    const item = counts.get(key) || {
      text,
      count: 0,
      users: new Set<string>(),
      first: record.timestamp,
      last: record.timestamp,
    };
    item.count += 1;
    item.users.add(record.sender);
    item.first = Math.min(item.first, record.timestamp);
    item.last = Math.max(item.last, record.timestamp);
    counts.set(key, item);
  }

  const repeated = [...counts.values()]
    .filter((item) => item.count >= 3 || (item.count >= 2 && item.users.size >= 2))
    .sort((a, b) => b.count - a.count || b.users.size - a.users.size)
    .slice(0, limit)
    .map((item) => {
      const users = [...item.users].slice(0, 4).join("、");
      const timeRange = item.first === item.last
        ? formatDate(new Date(item.first * 1000))
        : `${formatDate(new Date(item.first * 1000))} 至 ${formatDate(new Date(item.last * 1000))}`;
      return `「${item.text}」：${item.count} 次｜${item.users.size} 人｜用户：${users}｜时间：${timeRange}`;
    });

  return [
    "复读/刷屏候选：",
    ...(repeated.length ? repeated : ["无明显复读/刷屏"]),
  ];
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

function buildRelationStats(records: ChatMessageRecord[], pairLimit = 10, mentionLimit = 8): string[] {
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
    .slice(0, pairLimit)
    .map((item) => `${item.a} ↔ ${item.b}：连续互动约 ${item.count} 次`);
  const topMentions = [...mentions.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, mentionLimit)
    .map((item) => `${item.from} → ${item.to}：点名 ${item.count} 次`);

  return [
    "本地互动候选：",
    ...(topPairs.length ? topPairs : ["无明显连续互动候选"]),
    "本地点名候选：",
    ...(topMentions.length ? topMentions : ["无明显 @ 点名"]),
  ];
}

function prepareCpInput(records: ChatMessageRecord[]): PreparedInput {
  const sampled = prepareSummaryInput(records);
  const outputHint = records.length >= 800
    ? "输出控制：最甜 CP 1 组；其他 CP 6-8 组；每组必须写互动次数、称号和糖度；不要照抄全部候选。"
    : records.length >= 200
    ? "输出控制：最甜 CP 1 组；其他 CP 4-6 组；每组必须写互动次数、称号和糖度；不要照抄全部候选。"
    : "输出控制：最甜 CP 1 组；其他 CP 3-5 组；不要硬凑低互动组合；互动少于 3 次的组合只有特别有名场面时才写。";
  const pairLimit = records.length >= 800 ? 12 : records.length >= 200 ? 9 : 6;
  const mentionLimit = records.length >= 800 ? 8 : records.length >= 200 ? 6 : 4;
  const quoteLimit = records.length >= 800 ? 70 : records.length >= 200 ? 55 : 35;
  const sampleLimit = records.length >= 800 ? 130 : records.length >= 200 ? 110 : 80;
  return {
    lines: [
      "CP 模式边界：只分析群聊互动和节目效果，不暗示现实关系。",
      outputHint,
      "互动次数必须优先取自“连续互动约 N 次”或“点名 N 次”，不要凭空编很精确的数字。",
      "",
      ...buildRelationStats(records, pairLimit, mentionLimit),
      "",
      ...buildRepeatStats(records, 6),
      "",
      ...buildQuoteCandidateLines(records).slice(0, quoteLimit),
      "",
      "代表性消息：",
      ...sampled.lines.slice(0, sampleLimit),
    ],
    note: "已整理互动次数、点名关系和代表性上下文",
  };
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
      ...buildRepeatStats(records, 8),
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
      ...buildRepeatStats(records, 8),
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
      ...buildRepeatStats(records, 6),
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
      ...buildRepeatStats(records, 6),
      "",
      "代表性消息：",
      ...sampled.lines.slice(0, 100),
    ],
    note: `已筛选 ${records.length} 条消息中的金句候选，并附带代表性上下文`,
  };
}

export function prepareCompareInput(
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
      ...buildRepeatStats(records, 6),
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

export function prepareKeywordInput(records: ChatMessageRecord[], keyword: string): PreparedInput {
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

function prepareGeneralModeInput(records: ChatMessageRecord[], mode: SumMode): PreparedInput {
  const sampled = prepareSummaryInput(records);
  const localStats = buildLocalSummaryStats(records, sampled);
  const quoteLimit = records.length >= 500 ? 80 : records.length >= 120 ? 60 : 35;
  const sampleLimit = records.length >= 500 ? 150 : records.length >= 120 ? 120 : 80;
  const lines = [
    `模式提示：${mode} 模式需要结合本地统计、复读/刷屏候选、金句候选和代表性消息判断重点。`,
    "",
    ...localStats,
    "",
    ...buildMemeStats(records),
    "",
    ...buildQuoteCandidateLines(records).slice(0, quoteLimit),
    "",
    "代表性消息：",
    ...sampled.lines.slice(0, sampleLimit),
  ];
  return {
    lines,
    note: `已为 ${mode} 模式整理本地统计、复读/刷屏候选、热词、金句和代表性消息`,
  };
}

export function prepareSpecialInput(mode: SumMode, records: ChatMessageRecord[], keyword?: string): PreparedInput {
  if (mode === "rank") return prepareRankInput(records);
  if (mode === "links") return prepareLinksInput(records);
  if (mode === "about") return prepareKeywordInput(records, keyword || "");
  if (mode === "meme") return prepareMemeInput(records);
  if (mode === "roast") return prepareRoastInput(records);
  if (mode === "relation") return prepareRelationInput(records);
  if (mode === "quotes") return prepareQuotesInput(records);
  if (mode === "cp") return prepareCpInput(records);
  if (mode === "award" || mode === "npc") return prepareRankInput(records);
  if (mode === "abstract" || mode === "mood") return prepareMemeInput(records);
  return prepareGeneralModeInput(records, mode);
}

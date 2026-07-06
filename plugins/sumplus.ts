import { getPrefixes } from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import { Api } from "teleproto";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { getGlobalClient } from "@utils/globalClient";
import { safeGetMessages } from "@utils/safeGetMessages";
import { JSONFilePreset } from "lowdb/node";
import * as path from "path";

import { modePrompts, personAnalysisPrompt, templatePolishPrompt, unifiedSummaryPrompt } from "./sumplus.prompts";
import { providerChainLines, summarize, tokenUsageText, trimTrailingSlash } from "./sumplus.provider";
import type { ProviderConfig, ProviderType, ProviderUseInfo, SumConfig, TokenUsage } from "./sumplus.provider";
import type {
  CachedIdentity,
  ChatMessageRecord,
  IdentityCache,
  MessageFetchResult,
  PreparedInput,
  SumMode,
  SummaryDensity,
} from "./sumplus.types";
import {
  addUnique,
  buildActiveHourStats,
  buildLocalSummaryStats,
  buildPersonChangeStats,
  buildPersonLocalStats,
  compactText,
  formatDate,
  getUserKey,
  parseKeywordQuery,
  prepareCompareInput,
  prepareKeywordInput,
  preparePersonInput,
  prepareSpecialInput,
  prepareSummaryInput,
  recordMatchesKeywordQuery,
  recordMatchesTarget,
  recordToLine,
  sortRecords,
  topUserStats,
} from "./sumplus.prepare";
const prefixes = getPrefixes();
const mainPrefix = prefixes[0] || ".";

// Keep individual messages and total prompt size bounded while respecting the user's requested history range.
// We do not cap the requested message count here; only oversized pasted messages/prompts are compacted.
const DURATION_PAGE_SIZE = 100;
const MAX_DURATION_FETCH_PAGES = 24;
const MAX_DURATION_FETCH_MESSAGES = 2000;
const configPath = path.join(
  createDirectoryInAssets("sum"),
  "config.json",
);
const identityCachePath = path.join(
  createDirectoryInAssets("sum"),
  "identity-cache.json",
);

type FooterMeta = {
  fetchResult: MessageFetchResult;
  prepared: PreparedInput;
  comparePreviousResult?: MessageFetchResult | null;
  usage?: TokenUsage;
  rangeLabel?: string;
};

type SilentMentionLink = {
  text: string;
  display: string;
  href: string;
  priority?: number;
};

type TextMatch = {
  start: number;
  end: number;
  link: SilentMentionLink;
};

type MarkdownLinkAnchor = {
  token: string;
  html: string;
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
  const links = new Map<string, SilentMentionLink>();
  const senderCounts = new Map<string, number>();

  for (const record of records) {
    senderCounts.set(record.senderId, (senderCounts.get(record.senderId) || 0) + 1);
  }

  const mentionDisplay = (value: string) => {
    const clean = String(value || "")
      .replace(/^[@＠]+/, "")
      .replace(/\s+([（(])/g, "$1")
      .replace(/([）)])\s+/g, "$1")
      .trim();
    return clean ? `＠${clean}` : "";
  };

  const add = (text: string, display: string, href: string, priority = 0) => {
    const raw = String(text || "").trim();
    if (!raw) return;
    const normalized = raw.replace(/^[@＠]+/, "").toLowerCase();
    if (normalized.length < 2) return;
    const key = `${raw.toLowerCase()}|${href}`;
    const current = links.get(key);
    if (current && (current.priority || 0) >= priority) return;
    links.set(key, { text: raw, display, href, priority });
  };

  const addNameAliases = (record: ChatMessageRecord, href: string, priority: number) => {
    const first = record.firstName.trim();
    const last = record.lastName.trim();
    const sender = record.sender.trim();
    const compactLast = last.replace(/^[（(]+|[）)]+$/g, "").trim();
    const aliases = [
      sender,
      sender.replace(/\s+/g, ""),
      first,
      last,
      compactLast,
      first && last ? `${first} ${last}` : "",
      first && last ? `${first}${last}` : "",
      first && compactLast ? `${first}（${compactLast}）` : "",
      first && compactLast ? `${first}(${compactLast})` : "",
    ].filter(Boolean);

    for (const alias of aliases) {
      const display = mentionDisplay(alias);
      if (display) add(alias, display, href, priority);
    }
  };

  for (const record of records) {
    const username = record.username.replace(/^@/, "").trim();
    if (!username) continue;
    const href = `tg://resolve?domain=${encodeURIComponent(username)}`;
    const priority = (senderCounts.get(record.senderId) || 0) * 10;
    add(`@${username}`, `＠${username}`, href, priority + 3);
    add(username, `＠${username}`, href, priority + 2);
    addNameAliases(record, href, priority + 1);
  }

  return [...links.values()]
    .sort((a, b) => (b.priority || 0) - (a.priority || 0) || b.text.length - a.text.length)
    .slice(0, 600);
}

function mentionPattern(text: string): RegExp {
  const escaped = escapeRegExp(text);
  if (/^[A-Za-z0-9_@.-]+$/.test(text)) {
    return new RegExp(`(?<![A-Za-z0-9_@.-])${escaped}(?![A-Za-z0-9_@.-])`, "g");
  }
  return new RegExp(escaped, "g");
}

function linkifyMentionText(text: string, mentionLinks: SilentMentionLink[]): string {
  const matches: TextMatch[] = [];
  for (const item of mentionLinks) {
    const escapedText = htmlEscape(item.text);
    if (!escapedText) continue;
    for (const match of text.matchAll(mentionPattern(escapedText))) {
      const start = match.index ?? -1;
      if (start < 0) continue;
      matches.push({ start, end: start + match[0].length, link: item });
    }
  }

  if (!matches.length) return text;

  matches.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const selected: TextMatch[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start < cursor) continue;
    selected.push(match);
    cursor = match.end;
  }

  let result = "";
  cursor = 0;
  for (const match of selected) {
    result += text.slice(cursor, match.start);
    result += `<a href="${htmlEscape(match.link.href)}">${htmlEscape(match.link.display)}</a>`;
    cursor = match.end;
  }
  return result + text.slice(cursor);
}

function linkifySilentMentions(html: string, mentionLinks: SilentMentionLink[]): string {
  if (!mentionLinks.length) return html;
  const tags = html.split(/(<[^>]+>)/g);

  return tags.map((part) => {
    if (!part || part.startsWith("<")) return part;
    return linkifyMentionText(part, mentionLinks);
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
    cp: { mode: "cp", title: "互动嗑糖榜", defaultRangeToken: "24h" },
    couple: { mode: "cp", title: "互动嗑糖榜", defaultRangeToken: "24h" },
    pair: { mode: "cp", title: "互动嗑糖榜", defaultRangeToken: "24h" },
    嗑糖: { mode: "cp", title: "互动嗑糖榜", defaultRangeToken: "24h" },
    互动: { mode: "cp", title: "互动嗑糖榜", defaultRangeToken: "24h" },
    abstract: { mode: "abstract", title: "抽象指数报告", defaultRangeToken: "24h" },
    abs: { mode: "abstract", title: "抽象指数报告", defaultRangeToken: "24h" },
    抽象: { mode: "abstract", title: "抽象指数报告", defaultRangeToken: "24h" },
    award: { mode: "award", title: "群聊颁奖典礼", defaultRangeToken: "24h" },
    awards: { mode: "award", title: "群聊颁奖典礼", defaultRangeToken: "24h" },
    颁奖: { mode: "award", title: "群聊颁奖典礼", defaultRangeToken: "24h" },
    奖项: { mode: "award", title: "群聊颁奖典礼", defaultRangeToken: "24h" },
    mood: { mode: "mood", title: "群聊情绪天气", defaultRangeToken: "24h" },
    weather: { mode: "mood", title: "群聊情绪天气", defaultRangeToken: "24h" },
    情绪: { mode: "mood", title: "群聊情绪天气", defaultRangeToken: "24h" },
    天气: { mode: "mood", title: "群聊情绪天气", defaultRangeToken: "24h" },
    npc: { mode: "npc", title: "群友 RPG 职业分配", defaultRangeToken: "24h" },
    rpg: { mode: "npc", title: "群友 RPG 职业分配", defaultRangeToken: "24h" },
    职业: { mode: "npc", title: "群友 RPG 职业分配", defaultRangeToken: "24h" },
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
    "😏 今日槽点日报",
    "🍬 今日互动嗑糖榜",
    "🌀 今日抽象指数",
    "🏆 今日群聊颁奖典礼",
    "🌦️ 今日群聊天气",
    "🧙 今日群友职业分配",
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

  const users = Object.entries(db.data.users) as Array<[string, CachedIdentity]>;
  const recentUsers = users
    .sort((a, b) => (b[1].lastSeen || 0) - (a[1].lastSeen || 0))
    .slice(0, 2000);
  db.data.users = Object.fromEntries(recentUsers);
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

function buildModePrompt(mode: SumMode, chatName: string, keyword?: string): string {
  if (mode === "summary") return `${unifiedSummaryPrompt}${templatePolishPrompt}`;
  if (mode === "person") return `${personAnalysisPrompt}${templatePolishPrompt}`;
  const prompt = modePrompts[mode];
  if (mode === "about") {
    return `${prompt}${templatePolishPrompt}\n\n关键词：${keyword || ""}\n群名：${chatName}`;
  }
  return `${prompt}${templatePolishPrompt}\n\n群名：${chatName}`;
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
  const tokenText = tokenUsageText(meta.usage);
  const inputLine = `📥 消息：${meta.fetchResult.records.length} 条${compareText}${limitText}`;
  const detailLine = tokenText
    ? `🧮 ${tokenText}`
    : `🧩 输入：${inputNote}`;
  return [
    "",
    "---",
    `🤖 模型：${provider.name}｜${provider.model}`,
    inputLine,
    detailLine,
  ].join("\n");
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
      usage: summaryResult.usage,
      rangeLabel: effectiveRange.label,
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

const menuText = `▎SumPlus 摘要菜单

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
<code>${mainPrefix}sum cp 24h</code> - CP / 互动嗑糖榜
<code>${mainPrefix}sum abstract 24h</code> - 抽象指数报告
<code>${mainPrefix}sum award 24h</code> - 群聊颁奖典礼
<code>${mainPrefix}sum mood 24h</code> - 群聊情绪天气
<code>${mainPrefix}sum npc 24h</code> - 群友 RPG 职业分配

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

中文也能用：<code>热梗</code>、<code>吃瓜</code>、<code>吐槽</code>、<code>槽点</code>、<code>金句</code>、<code>关系</code>、<code>剧情</code>、<code>对比</code>、<code>追踪</code>、<code>嗑糖</code>、<code>抽象</code>、<code>颁奖</code>、<code>情绪</code>、<code>职业</code>。
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
<code>${mainPrefix}sum cp 24h</code> - CP / 互动嗑糖榜
<code>${mainPrefix}sum abstract 24h</code> - 抽象指数报告
<code>${mainPrefix}sum award 24h</code> - 群聊颁奖典礼
<code>${mainPrefix}sum mood 24h</code> - 群聊情绪天气
<code>${mainPrefix}sum npc 24h</code> - 群友 RPG 职业分配
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

class SumPlusPlugin extends Plugin {
  description: string = helpText;

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    sum: handleCommand,
    summary: handleCommand,
  };
}

export default new SumPlusPlugin();

import { createCanvas, loadImage, type CanvasRenderingContext2D } from "canvas";
import * as fs from "fs";
import * as path from "path";

import type { ChatMessageRecord, SumMode } from "./sumplus.types";

const WIDTH = 1080;
const HEIGHT = 1440;
const BODY_FONT = '"WenQuanYi Micro Hei", "PingFang SC", "Microsoft YaHei", sans-serif';
const AVATAR_CACHE_MS = 7 * 24 * 60 * 60 * 1000;
const NO_AVATAR_CACHE_MS = 24 * 60 * 60 * 1000;
const avatarCacheDir = path.join(process.cwd(), "assets", "sum", "avatar-cache");

type SummaryBlock = {
  heading: string;
  lines: string[];
  level: number;
};

type ImageUser = {
  key: string;
  display: string;
  sender: string;
  count: number;
  title: string;
  record: ChatMessageRecord;
  avatar: Buffer | null;
  image?: any;
};

type Theme = {
  background: string;
  ink: string;
  muted: string;
  primary: string;
  accent: string;
  signal: string;
  surface: string;
  line: string;
};

export type SummaryImageRenderInput = {
  client: any;
  chatName: string;
  title: string;
  mode: SumMode;
  summary: string;
  records: ChatMessageRecord[];
  providerName: string;
  model: string;
};

export type SummaryImageRenderOutput = {
  pages: Buffer[];
  avatarCount: number;
  renderMs: number;
};

const baseTheme: Theme = {
  background: "#e9f0ed",
  ink: "#112c2c",
  muted: "#61716d",
  primary: "#123b3a",
  accent: "#ff6758",
  signal: "#d9f06b",
  surface: "#f8faf8",
  line: "#b9c8c2",
};

function themeForMode(mode: SumMode): Theme {
  if (mode === "roast" || mode === "hot" || mode === "melon") {
    return { ...baseTheme, primary: "#342d38", accent: "#ff5e57", signal: "#ffd166" };
  }
  if (mode === "cp") {
    return { ...baseTheme, primary: "#263b46", accent: "#f05d8b", signal: "#ffc6d9" };
  }
  if (mode === "award" || mode === "npc") {
    return { ...baseTheme, primary: "#253346", accent: "#ff725e", signal: "#e4c96f" };
  }
  return baseTheme;
}

function compact(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function stripEmoji(value: string): string {
  return value
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D\u20E3]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanInline(value: string): string {
  return stripEmoji(
    String(value || "")
      .replace(/\[([^\]\n]+)]\((https?:\/\/[^\s)]+)\)/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/[*_`~]/g, "")
      .replace(/^\s*[-•]+\s*/, "")
      .replace(/^\s*\d+[.、]\s*/, "")
      .replace(/^\s*[|｜]\s*/, ""),
  );
}

function cleanHeading(value: string): string {
  return cleanInline(value)
    .replace(/^\d+\s*/, "")
    .replace(/^[：:|｜\-—]+\s*/, "")
    .trim();
}

function parseSummaryBlocks(summary: string): SummaryBlock[] {
  const body = summary.split(/\n---\n/)[0].trim();
  const blocks: SummaryBlock[] = [];
  let current: SummaryBlock | null = null;

  const flush = () => {
    if (!current) return;
    current.lines = current.lines.map(cleanInline).filter(Boolean);
    if (current.heading || current.lines.length) blocks.push(current);
    current = null;
  };

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flush();
      current = {
        heading: cleanHeading(heading[2]),
        lines: [],
        level: heading[1].length,
      };
      continue;
    }
    const boldHeading = line.match(/^\*\*([^*\n]+)\*\*[：:]?$/);
    if (boldHeading) {
      flush();
      current = { heading: cleanHeading(boldHeading[1]), lines: [], level: 2 };
      continue;
    }
    if (!current) current = { heading: "摘要", lines: [], level: 2 };
    current.lines.push(line);
  }
  flush();
  return blocks;
}

function isMetadataHeading(heading: string): boolean {
  return /基本信息|群聊天气|统计概览|摘要$/.test(heading);
}

function isLeadHeading(heading: string): boolean {
  return /一句话总结|今日主线|今日主槽|今日结论|颁奖词|温柔收尾|轻轻收住/.test(heading);
}

function blockBody(block: SummaryBlock): string {
  const preferred = block.lines.filter((line) => !/主要参与|时间范围|消息总量|核心用户|活跃时段/.test(line));
  return compact((preferred.length ? preferred : block.lines).slice(0, 4).join(" "));
}

function uniqueBlocks(blocks: SummaryBlock[]): SummaryBlock[] {
  const seen = new Set<string>();
  const result: SummaryBlock[] = [];
  for (const block of blocks) {
    const heading = cleanHeading(block.heading);
    const body = blockBody(block);
    if (!heading || !body || isMetadataHeading(heading)) continue;
    const key = `${heading}|${body}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...block, heading, lines: block.lines.map(cleanInline).filter(Boolean) });
  }
  return result;
}

function selectContent(summary: string): { lead: string; blocks: SummaryBlock[] } {
  const parsed = parseSummaryBlocks(summary);
  const leadBlock = parsed.find((block) => isLeadHeading(block.heading));
  const nested = parsed.filter((block) => block.level >= 3 && !isLeadHeading(block.heading));
  const major = parsed.filter((block) => block.level === 2 && !isLeadHeading(block.heading));
  const blocks = uniqueBlocks([...nested, ...major]);
  const lead = blockBody(leadBlock || blocks[0] || { heading: "", lines: ["本期群聊内容已整理完成。"], level: 2 });
  return { lead, blocks };
}

function topImageUsers(records: ChatMessageRecord[], summary: string, limit = 5): ImageUser[] {
  const users = new Map<string, { record: ChatMessageRecord; count: number }>();
  for (const record of records) {
    const key = record.senderId || record.username || record.sender;
    const current = users.get(key);
    if (!current) {
      users.set(key, { record, count: 1 });
      continue;
    }
    current.count += 1;
    if (record.timestamp >= current.record.timestamp) current.record = record;
  }

  const summaryLines = summary.split(/\r?\n/).map(cleanInline).filter(Boolean);
  return [...users.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, limit)
    .map(([key, item], index) => {
      const record = item.record;
      const display = record.username ? `@${record.username.replace(/^@/, "")}` : record.sender;
      const aliases = [display, record.sender, record.sender.replace(/[（(].*$/, ""), record.username]
        .map((value) => compact(value).replace(/^@/, ""))
        .filter(Boolean);
      let title = "";
      for (const line of summaryLines) {
        if (!aliases.some((alias) => line.toLowerCase().includes(alias.toLowerCase()))) continue;
        const match = line.match(/称号[：:]\s*([^｜|，,。]{2,18})/);
        if (match) {
          title = compact(match[1]);
          break;
        }
      }
      const fallbacks = ["话题永动机", "高频输出位", "稳定参与者", "气氛接力手", "群聊观察员"];
      return {
        key,
        display,
        sender: record.sender,
        count: item.count,
        title: title || fallbacks[index] || "活跃参与者",
        record,
        avatar: null,
      };
    });
}

function safeCacheKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 96) || "unknown";
}

async function freshFile(filePath: string, maxAgeMs: number): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(filePath);
    return Date.now() - stat.mtimeMs <= maxAgeMs;
  } catch {
    return false;
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("avatar timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function downloadAvatar(client: any, user: ImageUser): Promise<Buffer | null> {
  await fs.promises.mkdir(avatarCacheDir, { recursive: true });
  const cacheKey = safeCacheKey(user.record.senderId || user.record.username || user.key);
  const cachePath = path.join(avatarCacheDir, `${cacheKey}.jpg`);
  const noAvatarPath = path.join(avatarCacheDir, `${cacheKey}.none`);

  if (await freshFile(cachePath, AVATAR_CACHE_MS)) {
    return fs.promises.readFile(cachePath);
  }
  if (await freshFile(noAvatarPath, NO_AVATAR_CACHE_MS)) return null;

  const candidates: any[] = [];
  if (user.record.username) candidates.push(`@${user.record.username.replace(/^@/, "")}`);
  if (user.record.senderId && /^\d+$/.test(user.record.senderId)) {
    const numericId = Number(user.record.senderId);
    if (Number.isSafeInteger(numericId)) candidates.push(numericId);
  }
  if (user.record.senderId) candidates.push(user.record.senderId);

  for (const candidate of candidates) {
    try {
      const downloaded = await withTimeout(
        client.downloadProfilePhoto(candidate, { isBig: false }),
        4000,
      );
      const buffer = Buffer.isBuffer(downloaded)
        ? downloaded
        : typeof downloaded === "string" && downloaded
        ? await fs.promises.readFile(downloaded)
        : null;
      if (!buffer?.length) continue;
      await fs.promises.writeFile(cachePath, buffer);
      await fs.promises.rm(noAvatarPath, { force: true });
      return buffer;
    } catch {
      // Try the next stable identity representation.
    }
  }

  await fs.promises.writeFile(noAvatarPath, String(Date.now()));
  return null;
}

function setFont(ctx: CanvasRenderingContext2D, size: number, weight = 400): void {
  ctx.font = `${weight} ${size}px ${BODY_FONT}`;
}

function tokenize(value: string): string[] {
  return value.match(/[A-Za-z0-9_@./:+-]+|\s+|./gu) || [];
}

function wrapText(ctx: CanvasRenderingContext2D, value: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const token of tokenize(compact(value))) {
    const next = `${current}${token}`;
    if (!current || ctx.measureText(next).width <= maxWidth) {
      current = next;
      continue;
    }
    lines.push(current.trimEnd());
    current = token.trimStart();
  }
  if (current.trim()) lines.push(current.trim());
  return lines;
}

function drawWrappedText(
  ctx: CanvasRenderingContext2D,
  value: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number,
  color: string,
): number {
  const lines = wrapText(ctx, value, maxWidth);
  const visible = lines.slice(0, maxLines);
  if (lines.length > maxLines && visible.length) {
    let last = visible[visible.length - 1];
    while (last && ctx.measureText(`${last}...`).width > maxWidth) last = last.slice(0, -1);
    visible[visible.length - 1] = `${last}...`;
  }
  ctx.fillStyle = color;
  visible.forEach((line, index) => ctx.fillText(line, x, y + index * lineHeight));
  return visible.length * lineHeight;
}

function fitLine(ctx: CanvasRenderingContext2D, value: string, maxWidth: number): string {
  let result = compact(value);
  while (result && ctx.measureText(result).width > maxWidth) result = result.slice(0, -1);
  return result === compact(value) ? result : `${result.slice(0, -2)}...`;
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.fill();
}

function initialFor(user: ImageUser): string {
  return Array.from(user.display.replace(/^@/, "").trim())[0]?.toUpperCase() || "?";
}

function drawAvatar(
  ctx: CanvasRenderingContext2D,
  user: ImageUser,
  x: number,
  y: number,
  size: number,
  theme: Theme,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.clip();
  if (user.image) {
    const sourceWidth = Number(user.image.width || size);
    const sourceHeight = Number(user.image.height || size);
    const scale = Math.max(size / sourceWidth, size / sourceHeight);
    const width = sourceWidth * scale;
    const height = sourceHeight * scale;
    ctx.drawImage(user.image, x + (size - width) / 2, y + (size - height) / 2, width, height);
  } else {
    ctx.fillStyle = theme.accent;
    ctx.fillRect(x, y, size, size);
    ctx.fillStyle = "#ffffff";
    setFont(ctx, Math.round(size * 0.38), 700);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(initialFor(user), x + size / 2, y + size / 2 + 1);
  }
  ctx.restore();
  ctx.strokeStyle = theme.signal;
  ctx.lineWidth = Math.max(3, Math.round(size * 0.055));
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2 - ctx.lineWidth / 2, 0, Math.PI * 2);
  ctx.stroke();
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
}

function formatDate(records: ChatMessageRecord[]): string {
  const timestamp = records[records.length - 1]?.timestamp || Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((value, index) => (index === 0 ? String(value) : String(value).padStart(2, "0")))
    .join(".");
}

function activePeak(records: ChatMessageRecord[]): string {
  const counts = new Map<number, number>();
  records.forEach((record) => {
    const hour = new Date(record.timestamp * 1000).getHours();
    counts.set(hour, (counts.get(hour) || 0) + 1);
  });
  const hour = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (hour === undefined) return "--:--";
  return `${String(hour).padStart(2, "0")}:00`;
}

function participantCount(records: ChatMessageRecord[]): number {
  return new Set(records.map((record) => record.senderId || record.username || record.sender)).size;
}

function drawHeader(
  ctx: CanvasRenderingContext2D,
  input: SummaryImageRenderInput,
  users: ImageUser[],
  theme: Theme,
  compactHeader = false,
): void {
  const height = compactHeader ? 120 : 150;
  ctx.fillStyle = theme.primary;
  ctx.fillRect(0, 0, WIDTH, height);
  ctx.fillStyle = theme.signal;
  ctx.fillRect(0, 0, 14, height);
  ctx.fillStyle = theme.signal;
  setFont(ctx, compactHeader ? 36 : 46, 800);
  ctx.fillText("SUM+", 42, compactHeader ? 34 : 42);
  ctx.fillStyle = "#ffffff";
  setFont(ctx, compactHeader ? 18 : 22, 700);
  ctx.fillText("DAILY SIGNAL", compactHeader ? 160 : 180, compactHeader ? 47 : 57);
  ctx.fillStyle = "#d7e4df";
  setFont(ctx, 21, 500);
  ctx.fillText(formatDate(input.records), compactHeader ? 820 : 535, compactHeader ? 44 : 52);

  if (!compactHeader) {
    const shown = users.slice(0, 5);
    const size = 62;
    const gap = 10;
    const startX = WIDTH - 34 - shown.length * size - Math.max(0, shown.length - 1) * gap;
    shown.forEach((user, index) => drawAvatar(ctx, user, startX + index * (size + gap), 42, size, theme));
  }
}

function drawCard(
  ctx: CanvasRenderingContext2D,
  block: SummaryBlock,
  index: number,
  x: number,
  y: number,
  width: number,
  height: number,
  theme: Theme,
): void {
  ctx.fillStyle = theme.surface;
  roundedRect(ctx, x, y, width, height, 18);
  ctx.fillStyle = theme.primary;
  setFont(ctx, 58, 800);
  ctx.fillText(String(index + 1).padStart(2, "0"), x + 24, y + 20);
  ctx.fillStyle = theme.accent;
  ctx.fillRect(x + 28, y + 91, 58, 7);
  ctx.fillStyle = theme.ink;
  setFont(ctx, 31, 750);
  ctx.fillText(fitLine(ctx, block.heading, width - 132), x + 116, y + 30);
  setFont(ctx, 25, 450);
  drawWrappedText(ctx, blockBody(block), x + 28, y + 120, width - 56, 38, 3, theme.ink);
}

function drawPeopleStrip(
  ctx: CanvasRenderingContext2D,
  users: ImageUser[],
  theme: Theme,
): void {
  const y = 1150;
  ctx.fillStyle = theme.primary;
  ctx.fillRect(34, y, 8, 42);
  ctx.fillStyle = theme.ink;
  setFont(ctx, 31, 750);
  ctx.fillText("今日人物", 58, y + 1);
  ctx.strokeStyle = theme.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(210, y + 21);
  ctx.lineTo(WIDTH - 34, y + 21);
  ctx.stroke();

  const shown = users.slice(0, 3);
  const columnWidth = (WIDTH - 68) / 3;
  shown.forEach((user, index) => {
    const x = 34 + index * columnWidth;
    if (index > 0) {
      ctx.strokeStyle = theme.line;
      ctx.beginPath();
      ctx.moveTo(x, y + 65);
      ctx.lineTo(x, y + 185);
      ctx.stroke();
    }
    drawAvatar(ctx, user, x + 20, y + 70, 96, theme);
    ctx.fillStyle = theme.ink;
    setFont(ctx, 25, 700);
    ctx.fillText(fitLine(ctx, user.display, columnWidth - 145), x + 135, y + 80);
    ctx.fillStyle = theme.muted;
    setFont(ctx, 21, 450);
    ctx.fillText(fitLine(ctx, user.title, columnWidth - 145), x + 135, y + 124);
    setFont(ctx, 18, 450);
    ctx.fillText(`${user.count} 条`, x + 135, y + 158);
  });
}

function drawFooter(
  ctx: CanvasRenderingContext2D,
  input: SummaryImageRenderInput,
  page: number,
  total: number,
  theme: Theme,
): void {
  ctx.strokeStyle = theme.primary;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(34, 1388);
  ctx.lineTo(WIDTH - 34, 1388);
  ctx.stroke();
  ctx.fillStyle = theme.muted;
  setFont(ctx, 18, 450);
  ctx.textAlign = "center";
  ctx.fillText(`SumPlus · ${input.providerName} · ${input.model} · ${page}/${total}`, WIDTH / 2, 1405);
  ctx.textAlign = "left";
}

function renderCoverPage(
  input: SummaryImageRenderInput,
  users: ImageUser[],
  lead: string,
  cards: SummaryBlock[],
  totalPages: number,
  theme: Theme,
): Buffer {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");
  ctx.textBaseline = "top";
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  drawHeader(ctx, input, users, theme);

  ctx.fillStyle = theme.ink;
  setFont(ctx, 58, 800);
  ctx.fillText(fitLine(ctx, cleanHeading(input.title).split("｜")[0], 760), 34, 188);
  ctx.fillStyle = theme.muted;
  setFont(ctx, 24, 550);
  ctx.fillText(fitLine(ctx, input.chatName, 270), 776, 211);

  ctx.fillStyle = theme.surface;
  roundedRect(ctx, 34, 278, WIDTH - 68, 88, 16);
  const stats = [
    [recordsLabel(input.records.length), "消息"],
    [String(participantCount(input.records)), "参与者"],
    [activePeak(input.records), "活跃高峰"],
  ];
  stats.forEach(([value, label], index) => {
    const x = 64 + index * 310;
    ctx.fillStyle = index === 2 ? theme.accent : theme.primary;
    setFont(ctx, 27, 800);
    ctx.fillText(value, x, 296);
    ctx.fillStyle = theme.muted;
    setFont(ctx, 17, 550);
    ctx.fillText(label, x, 333);
  });

  ctx.fillStyle = theme.primary;
  ctx.fillRect(34, 400, 8, 42);
  ctx.fillStyle = theme.ink;
  setFont(ctx, 31, 750);
  ctx.fillText("TODAY'S SIGNAL", 58, 400);
  setFont(ctx, 27, 450);
  drawWrappedText(ctx, lead, 58, 458, WIDTH - 116, 42, 3, theme.ink);

  const cardY = 590;
  const gap = 20;
  const cardWidth = (WIDTH - 68 - gap) / 2;
  const cardHeight = 250;
  cards.slice(0, 4).forEach((block, index) => {
    const row = Math.floor(index / 2);
    const col = index % 2;
    const x = 34 + col * (cardWidth + gap);
    const y = cardY + row * (cardHeight + gap);
    const isLastOdd = cards.length === 3 && index === 2;
    drawCard(ctx, block, index, x, y, isLastOdd ? WIDTH - 68 : cardWidth, cardHeight, theme);
  });

  drawPeopleStrip(ctx, users, theme);
  drawFooter(ctx, input, 1, totalPages, theme);
  return canvas.toBuffer("image/png", { compressionLevel: 3 });
}

function recordsLabel(value: number): string {
  return value >= 1000 ? value.toLocaleString("en-US") : String(value);
}

function renderDetailPage(
  input: SummaryImageRenderInput,
  blocks: SummaryBlock[],
  page: number,
  totalPages: number,
  theme: Theme,
): Buffer {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");
  ctx.textBaseline = "top";
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  drawHeader(ctx, input, [], theme, true);

  ctx.fillStyle = theme.ink;
  setFont(ctx, 48, 800);
  ctx.fillText("更多内容", 34, 164);
  ctx.fillStyle = theme.muted;
  setFont(ctx, 22, 500);
  ctx.fillText(fitLine(ctx, input.chatName, 400), 650, 183);

  let y = 250;
  blocks.forEach((block, index) => {
    const height = 255;
    ctx.fillStyle = theme.surface;
    roundedRect(ctx, 34, y, WIDTH - 68, height, 18);
    ctx.fillStyle = theme.accent;
    ctx.fillRect(34, y, 10, height);
    ctx.fillStyle = theme.primary;
    setFont(ctx, 42, 800);
    ctx.fillText(String((page - 2) * 4 + index + 5).padStart(2, "0"), 72, y + 25);
    ctx.fillStyle = theme.ink;
    setFont(ctx, 31, 750);
    ctx.fillText(fitLine(ctx, block.heading, 780), 170, y + 31);
    setFont(ctx, 25, 450);
    drawWrappedText(ctx, blockBody(block), 170, y + 91, 820, 38, 4, theme.ink);
    y += height + 22;
  });

  drawFooter(ctx, input, page, totalPages, theme);
  return canvas.toBuffer("image/png", { compressionLevel: 3 });
}

async function loadUserImages(users: ImageUser[], client: any): Promise<number> {
  await Promise.all(users.map(async (user) => {
    user.avatar = await downloadAvatar(client, user);
    if (!user.avatar) return;
    try {
      user.image = await loadImage(user.avatar);
    } catch {
      user.avatar = null;
    }
  }));
  return users.filter((user) => Boolean(user.image)).length;
}

export async function renderSummaryImages(input: SummaryImageRenderInput): Promise<SummaryImageRenderOutput> {
  const startedAt = Date.now();
  const theme = themeForMode(input.mode);
  const users = topImageUsers(input.records, input.summary, 5);
  const avatarCount = await loadUserImages(users, input.client);
  const content = selectContent(input.summary);
  const cards = content.blocks.slice(0, 4);
  if (!cards.length) {
    cards.push({ heading: "本期概览", lines: [content.lead], level: 2 });
  }
  const remaining = content.blocks.slice(cards.length);
  const detailChunks: SummaryBlock[][] = [];
  for (let index = 0; index < remaining.length; index += 4) {
    detailChunks.push(remaining.slice(index, index + 4));
  }
  const totalPages = Math.max(1, 1 + detailChunks.length);
  const pages = [renderCoverPage(input, users, content.lead, cards, totalPages, theme)];
  detailChunks.forEach((chunk, index) => {
    pages.push(renderDetailPage(input, chunk, index + 2, totalPages, theme));
  });
  return {
    pages,
    avatarCount,
    renderMs: Date.now() - startedAt,
  };
}

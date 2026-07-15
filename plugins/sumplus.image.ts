import { createCanvas, loadImage, type CanvasRenderingContext2D } from "canvas";
import * as fs from "fs";
import * as path from "path";

import type { ChatMessageRecord, SumMode } from "./sumplus.types";

const WIDTH = 1080;
const MIN_HEIGHT = 1680;
const MAX_HEIGHT = 8200;
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
  background: "#fff7e5",
  ink: "#26334a",
  muted: "#738096",
  primary: "#315f9b",
  accent: "#f05a4f",
  signal: "#ffd76a",
  surface: "#fffdf7",
  line: "#decfae",
};

function themeForMode(mode: SumMode): Theme {
  if (mode === "roast" || mode === "hot" || mode === "melon") {
    return { ...baseTheme, primary: "#36568a", accent: "#e94f45", signal: "#ffca61" };
  }
  if (mode === "cp") {
    return { ...baseTheme, primary: "#4c6594", accent: "#ed6b91", signal: "#ffd2df" };
  }
  if (mode === "award" || mode === "npc") {
    return { ...baseTheme, primary: "#355b8d", accent: "#e7604f", signal: "#f6ce63" };
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

function fitLine(ctx: CanvasRenderingContext2D, value: string, maxWidth: number): string {
  const original = compact(value);
  let result = original;
  while (result && ctx.measureText(`${result}...`).width > maxWidth) result = result.slice(0, -1);
  return result === original ? result : `${result}...`;
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.fill();
}

function initialFor(user: ImageUser): string {
  return Array.from(user.display.replace(/^@/, "").trim())[0]?.toUpperCase() || "?";
}

function drawAvatar(ctx: CanvasRenderingContext2D, user: ImageUser, x: number, y: number, size: number, theme: Theme): void {
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
    ctx.fillStyle = theme.primary;
    ctx.fillRect(x, y, size, size);
    ctx.fillStyle = "#ffffff";
    setFont(ctx, Math.round(size * 0.38), 700);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(initialFor(user), x + size / 2, y + size / 2 + 1);
  }
  ctx.restore();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2 - 3, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.stroke();
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
}

function drawFish(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number, theme: Theme): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-0.08);
  ctx.fillStyle = theme.signal;
  ctx.beginPath();
  ctx.ellipse(0, 0, 92 * scale, 58 * scale, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = theme.accent;
  ctx.beginPath();
  ctx.moveTo(-74 * scale, 0);
  ctx.lineTo(-142 * scale, -54 * scale);
  ctx.lineTo(-135 * scale, 55 * scale);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = theme.ink;
  ctx.lineWidth = 5 * scale;
  ctx.beginPath();
  ctx.ellipse(0, 0, 92 * scale, 58 * scale, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = theme.ink;
  ctx.beginPath();
  ctx.arc(43 * scale, -15 * scale, 7 * scale, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = theme.ink;
  ctx.lineWidth = 4 * scale;
  ctx.beginPath();
  ctx.arc(55 * scale, 9 * scale, 19 * scale, 0.2, 1.3);
  ctx.stroke();
  ctx.restore();
}

function formatDate(records: ChatMessageRecord[]): string {
  const timestamp = records[records.length - 1]?.timestamp || Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000);
  return `${date.getFullYear()} / ${String(date.getMonth() + 1).padStart(2, "0")} / ${String(date.getDate()).padStart(2, "0")}`;
}

function activePeak(records: ChatMessageRecord[]): string {
  const counts = new Map<number, number>();
  records.forEach((record) => {
    const hour = new Date(record.timestamp * 1000).getHours();
    counts.set(hour, (counts.get(hour) || 0) + 1);
  });
  const hour = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return hour === undefined ? "--:--" : `${String(hour).padStart(2, "0")}:00`;
}

function participantCount(records: ChatMessageRecord[]): number {
  return new Set(records.map((record) => record.senderId || record.username || record.sender)).size;
}

function reportBlocks(summary: string): { lead: string; blocks: SummaryBlock[] } {
  const parsed = parseSummaryBlocks(summary);
  const leadBlock = parsed.find((block) => isLeadHeading(block.heading));
  const lead = blockBody(leadBlock || { heading: "", lines: ["本期群聊已整理完成，先摸会儿鱼再慢慢看。"], level: 2 });
  const blocks = parsed
    .filter((block) => block.level > 1 && block !== leadBlock)
    .map((block) => ({ ...block, heading: cleanHeading(block.heading), lines: block.lines.map(cleanInline).filter(Boolean) }))
    .filter((block) => block.heading && (block.lines.length > 0 || /重点话题|本期亮点|名场面|待办|话唠榜|核心/.test(block.heading)));
  return { lead, blocks };
}

type MeasuredBlock = SummaryBlock & {
  bodyLines: string[];
  height: number;
  group: boolean;
};

function measureBlocks(ctx: CanvasRenderingContext2D, blocks: SummaryBlock[], fontSize: number, lineHeight: number): MeasuredBlock[] {
  setFont(ctx, fontSize, 450);
  return blocks.map((block) => {
    const group = block.lines.length === 0;
    const bodyLines = group ? [] : block.lines.flatMap((line) => wrapText(ctx, line, 850));
    return {
      ...block,
      bodyLines,
      group,
      height: group ? 92 : Math.max(168, 100 + bodyLines.length * lineHeight + 34),
    };
  });
}

function drawPaperBackground(ctx: CanvasRenderingContext2D, height: number, theme: Theme): void {
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, WIDTH, height);
  ctx.fillStyle = "rgba(49,95,155,0.08)";
  for (let y = 28; y < height; y += 42) {
    for (let x = 28; x < WIDTH; x += 42) {
      ctx.beginPath();
      ctx.arc(x, y, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.fillStyle = "rgba(240,90,79,0.08)";
  ctx.fillRect(0, 0, 22, height);
}

function drawHeader(ctx: CanvasRenderingContext2D, input: SummaryImageRenderInput, users: ImageUser[], theme: Theme): number {
  ctx.fillStyle = theme.signal;
  roundedRect(ctx, 48, 42, 984, 310, 34);
  ctx.strokeStyle = theme.ink;
  ctx.lineWidth = 4;
  ctx.setLineDash([14, 10]);
  ctx.strokeRect(66, 60, 948, 274);
  ctx.setLineDash([]);

  ctx.fillStyle = theme.accent;
  roundedRect(ctx, 80, 76, 260, 48, 24);
  ctx.fillStyle = "#ffffff";
  setFont(ctx, 22, 700);
  ctx.fillText("SUMPLUS · 摸鱼版", 106, 86);

  ctx.fillStyle = theme.ink;
  setFont(ctx, 70, 800);
  ctx.fillText(fitLine(ctx, cleanHeading(input.title).split("｜")[0], 620), 82, 148);
  ctx.fillStyle = theme.primary;
  setFont(ctx, 25, 700);
  ctx.fillText(fitLine(ctx, input.chatName, 470), 86, 250);
  ctx.fillStyle = theme.muted;
  setFont(ctx, 21, 600);
  ctx.fillText(formatDate(input.records), 350, 254);
  drawFish(ctx, 845, 190, 0.82, theme);

  const stats = [
    [`${input.records.length}`, "条消息"],
    [`${participantCount(input.records)}`, "位群友"],
    [activePeak(input.records), "最热闹"],
  ];
  stats.forEach(([value, label], index) => {
    const x = 70 + index * 330;
    ctx.fillStyle = index === 1 ? "#dff1ee" : index === 2 ? "#ffe2dc" : "#e5effb";
    roundedRect(ctx, x, 380, 300, 104, 22);
    ctx.fillStyle = index === 2 ? theme.accent : theme.primary;
    setFont(ctx, 31, 800);
    ctx.fillText(value, x + 28, 398);
    ctx.fillStyle = theme.muted;
    setFont(ctx, 18, 650);
    ctx.fillText(label, x + 28, 446);
  });

  if (users.length) {
    ctx.fillStyle = theme.ink;
    setFont(ctx, 28, 800);
    ctx.fillText("今日摸鱼搭子", 70, 530);
    ctx.strokeStyle = theme.line;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(258, 549);
    ctx.lineTo(1010, 549);
    ctx.stroke();
    users.slice(0, 4).forEach((user, index) => {
      const x = 72 + index * 244;
      drawAvatar(ctx, user, x, 590, 82, theme);
      ctx.fillStyle = theme.ink;
      setFont(ctx, 20, 750);
      ctx.fillText(fitLine(ctx, user.display, 142), x + 96, 598);
      ctx.fillStyle = theme.muted;
      setFont(ctx, 17, 550);
      ctx.fillText(fitLine(ctx, user.title, 142), x + 96, 632);
      ctx.fillText(`${user.count} 条`, x + 96, 660);
    });
  }
  return users.length ? 712 : 520;
}

function drawLead(ctx: CanvasRenderingContext2D, lead: string, y: number, theme: Theme): number {
  setFont(ctx, 27, 500);
  const lines = wrapText(ctx, lead, 830);
  const height = 90 + lines.length * 42;
  ctx.save();
  ctx.translate(540, y + height / 2);
  ctx.rotate(-0.012);
  ctx.fillStyle = "#dff0fb";
  ctx.shadowColor = "rgba(73,60,38,0.14)";
  ctx.shadowBlur = 16;
  ctx.shadowOffsetY = 8;
  roundedRect(ctx, -470, -height / 2, 940, height, 22);
  ctx.restore();
  ctx.fillStyle = theme.accent;
  setFont(ctx, 24, 800);
  ctx.fillText("今日一句", 104, y + 28);
  ctx.fillStyle = theme.ink;
  setFont(ctx, 27, 500);
  lines.forEach((line, index) => ctx.fillText(line, 104, y + 72 + index * 42));
  return height;
}

function drawGroupHeading(ctx: CanvasRenderingContext2D, block: MeasuredBlock, y: number, theme: Theme): void {
  ctx.fillStyle = theme.accent;
  roundedRect(ctx, 70, y + 15, 16, 54, 8);
  ctx.fillStyle = theme.ink;
  setFont(ctx, 34, 800);
  ctx.fillText(block.heading, 108, y + 18);
  ctx.strokeStyle = theme.line;
  ctx.lineWidth = 3;
  ctx.setLineDash([10, 10]);
  ctx.beginPath();
  ctx.moveTo(108, y + 72);
  ctx.lineTo(1004, y + 72);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawContentCard(
  ctx: CanvasRenderingContext2D,
  block: MeasuredBlock,
  index: number,
  y: number,
  fontSize: number,
  lineHeight: number,
  theme: Theme,
): void {
  const accents = [theme.accent, theme.primary, "#55aa91", "#e3a338"];
  const accent = accents[index % accents.length];
  ctx.save();
  ctx.shadowColor = "rgba(82,66,38,0.12)";
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 7;
  ctx.fillStyle = theme.surface;
  roundedRect(ctx, 62, y, 956, block.height, 24);
  ctx.restore();
  ctx.fillStyle = accent;
  roundedRect(ctx, 62, y, 12, block.height, 6);
  ctx.save();
  ctx.translate(540, y + 3);
  ctx.rotate(index % 2 === 0 ? -0.025 : 0.025);
  ctx.fillStyle = index % 2 === 0 ? "rgba(255,215,106,0.72)" : "rgba(127,200,232,0.58)";
  ctx.fillRect(-60, -10, 120, 28);
  ctx.restore();

  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(112, y + 52, 28, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  setFont(ctx, 20, 800);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(index + 1).padStart(2, "0"), 112, y + 53);
  ctx.textAlign = "left";
  ctx.textBaseline = "top";

  ctx.fillStyle = theme.ink;
  setFont(ctx, 31, 800);
  ctx.fillText(fitLine(ctx, block.heading, 790), 160, y + 31);
  setFont(ctx, fontSize, 450);
  let lineY = y + 94;
  block.bodyLines.forEach((line, lineIndex) => {
    const startsItem = lineIndex === 0 || block.lines.some((source) => cleanInline(source).startsWith(line));
    if (startsItem) {
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(103, lineY + lineHeight / 2 - 3, 5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = theme.ink;
    ctx.fillText(line, 130, lineY);
    lineY += lineHeight;
  });
}

function drawFooter(ctx: CanvasRenderingContext2D, input: SummaryImageRenderInput, height: number, theme: Theme): void {
  const y = height - 102;
  ctx.strokeStyle = theme.line;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(62, y);
  ctx.lineTo(1018, y);
  ctx.stroke();
  drawFish(ctx, 100, y + 45, 0.2, theme);
  ctx.fillStyle = theme.muted;
  setFont(ctx, 18, 550);
  ctx.textAlign = "center";
  ctx.fillText(`摸鱼日报由 SumPlus 生成 · ${input.providerName} · ${input.model}`, WIDTH / 2, y + 35);
  ctx.textAlign = "left";
}

function renderSingleLongImage(input: SummaryImageRenderInput, users: ImageUser[], theme: Theme): Buffer {
  const content = reportBlocks(input.summary);
  const measureCanvas = createCanvas(WIDTH, 200);
  const measureCtx = measureCanvas.getContext("2d");
  let fontSize = 27;
  let lineHeight = 43;
  let measured = measureBlocks(measureCtx, content.blocks, fontSize, lineHeight);
  setFont(measureCtx, 27, 500);
  const leadHeight = 90 + wrapText(measureCtx, content.lead, 830).length * 42;
  const headerHeight = users.length ? 712 : 520;
  const calculateHeight = () => headerHeight + 34 + leadHeight + 42 + measured.reduce((sum, block) => sum + block.height + 24, 0) + 130;
  let targetHeight = calculateHeight();
  if (targetHeight > MAX_HEIGHT) {
    fontSize = 23;
    lineHeight = 37;
    measured = measureBlocks(measureCtx, content.blocks, fontSize, lineHeight);
    targetHeight = calculateHeight();
  }
  if (targetHeight > MAX_HEIGHT) {
    fontSize = 20;
    lineHeight = 33;
    measured = measureBlocks(measureCtx, content.blocks, fontSize, lineHeight);
    targetHeight = calculateHeight();
  }
  const height = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, targetHeight));
  const canvas = createCanvas(WIDTH, height);
  const ctx = canvas.getContext("2d");
  ctx.textBaseline = "top";
  drawPaperBackground(ctx, height, theme);
  let y = drawHeader(ctx, input, users, theme) + 34;
  y += drawLead(ctx, content.lead, y, theme) + 42;
  let cardIndex = 0;
  measured.forEach((block) => {
    if (block.group) {
      drawGroupHeading(ctx, block, y, theme);
    } else {
      drawContentCard(ctx, block, cardIndex, y, fontSize, lineHeight, theme);
      cardIndex += 1;
    }
    y += block.height + 24;
  });
  drawFooter(ctx, input, height, theme);
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
  const users = topImageUsers(input.records, input.summary, 4);
  const avatarCount = await loadUserImages(users, input.client);
  const page = renderSingleLongImage(input, users, theme);
  return { pages: [page], avatarCount, renderMs: Date.now() - startedAt };
}

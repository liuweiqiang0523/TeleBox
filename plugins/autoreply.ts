import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { safeGetReplyMessage } from "@utils/safeGetMessages";
import { Api } from "teleproto";
import { JSONFilePreset } from "lowdb/node";
import path from "path";
import fs from "fs/promises";
import { generateShortReply } from "./sumplus.provider";
import type { SumConfig } from "./sumplus.provider";

const mainPrefix = getPrefixes()[0] || ".";

const htmlEscape = (text: string): string =>
  String(text).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#x27;",
  }[char] || char));

interface AutoReplyRule {
  chatId: string;
  userId: string;
  replyText: string;
  mode?: "fixed" | "ai";
  aiPersona?: string;
  displayName: string;
  createdAt: string;
}

interface AutoReplyDB {
  rules: Record<string, AutoReplyRule>;
}

const defaultState: AutoReplyDB = { rules: {} };
const helpText = `💬 <b>指定用户自动回复</b>
━━━━━━━━━━━━━━━━

<b>设置</b>
回复目标用户的一条消息，然后发送：
<code>${mainPrefix}autoreply 要回复的内容</code>
<code>${mainPrefix}autoreply ai</code> - 每句话使用 AI 回复
<code>${mainPrefix}autoreply ai 人设要求</code> - 使用指定语气回复
<code>${mainPrefix}autoreply fixed 固定内容</code> - 明确设置固定回复

<b>取消</b>
回复目标用户的一条消息，然后发送：
<code>${mainPrefix}autoreply off</code>

<b>管理</b>
<code>${mainPrefix}autoreply list</code> - 查看全部规则
<code>${mainPrefix}autoreply clear</code> - 清空全部规则

<i>规则按“当前群组 + 目标用户”生效。目标用户每发送一条文字消息，TeleBox 都会引用回复；AI 模式复用 .sum 的 API 与备用线路。</i>`;

class AutoReplyPlugin extends Plugin {
  public description = `指定用户每发一条文字消息就自动引用回复。\n\n${helpText}`;
  public cmdHandlers = { autoreply: this.handleCommand.bind(this) };
  public listenMessageHandler = this.handleMessage.bind(this);

  private dbPromise = JSONFilePreset<AutoReplyDB>(
    path.join(createDirectoryInAssets("autoreply"), "db.json"),
    defaultState,
  );
  private selfId: string | null = null;
  private sendQueues = new Map<string, Promise<void>>();
  private processedMessages = new Set<string>();
  private sumConfig: SumConfig | null = null;

  cleanup(): void {
    this.sendQueues.clear();
    this.processedMessages.clear();
    this.selfId = null;
    this.sumConfig = null;
  }

  private getChatId(msg: Api.Message): string | null {
    const raw = msg.chatId ?? msg.peerId;
    if (raw === undefined || raw === null) return null;
    return String(raw);
  }

  private getUserId(msg: Api.Message): string | null {
    if (!msg.senderId) return null;
    return String(msg.senderId);
  }

  private ruleKey(chatId: string, userId: string): string {
    return `${chatId}:${userId}`;
  }

  private async initializeSelf(): Promise<void> {
    if (this.selfId) return;
    const client = await getGlobalClient();
    if (!client) return;
    const me: any = await client.getMe();
    if (me?.id) this.selfId = String(me.id);
  }

  private async displayName(msg: Api.Message, fallbackId: string): Promise<string> {
    const sender: any = msg.sender;
    const first = sender?.firstName || sender?.first_name || "";
    const last = sender?.lastName || sender?.last_name || "";
    const username = sender?.username ? `@${sender.username}` : "";
    const name = `${first} ${last}`.trim();
    return name || username || fallbackId;
  }

  private async editResult(msg: Api.Message, text: string): Promise<void> {
    await msg.edit({ text, parseMode: "html", linkPreview: false });
  }

  private async getSumConfig(): Promise<SumConfig> {
    if (this.sumConfig) return this.sumConfig;
    const configPath = path.join(createDirectoryInAssets("sum"), "config.json");
    const raw = await fs.readFile(configPath, "utf8");
    this.sumConfig = JSON.parse(raw) as SumConfig;
    return this.sumConfig;
  }

  private aiSystemPrompt(rule: AutoReplyRule): string {
    const persona = rule.aiPersona?.trim();
    return [
      "你正在 Telegram 中文群聊中，替被点名挑衅的一方直接回击指定用户。",
      "必须结合中文互联网黑话、谐音、语境和点名方式判断真实含义，不能只按字面解释。",
      "特别规则：‘开溜某人’在辱骂语境里常指‘遛狗’，‘纯种某人’常是在把对方犬化、物化；遇到这类表达应识别为公开羞辱，而不是理解成离开现场。",
      "如果对方在点名、挂人、辱骂、犬化、贬低或挑衅：不要劝架，不要客服腔，不要示弱，不要说‘有事好好沟通’；直接用短、狠、尖锐、有梗、带压迫感的一句话反击。",
      "优先拆穿对方的低级羞辱、嘴臭、怂、双标和找存在感；允许明显嘲讽和强硬措辞，但不要机械复读对方原话。",
      "如果对方只是正常聊天，则自然简短地回应，不要无故开骂。",
      "只针对对方当前言行，不牵连家人，不攻击地域、民族、性别、疾病、残障、外貌等身份属性；不造谣、不威胁、不煽动骚扰。",
      "通常只输出一句，最多两句；不要分析、标题、前缀、引号、Markdown，也不要提到自己是 AI。",
      persona ? `额外人设与语气要求：${persona}` : "默认风格：嘴硬、毒舌、反应快，回击要有杀伤力但不给对方留下举报把柄。",
    ].join("\n");
  }

  private async handleCommand(msg: Api.Message): Promise<void> {
    try {
      const raw = msg.message || "";
      const firstSpace = raw.search(/\s/);
      const argument = firstSpace >= 0 ? raw.slice(firstSpace).trim() : "";
      const action = argument.toLowerCase();
      const db = await this.dbPromise;

      if (action === "list") {
        const rules = Object.values(db.data.rules);
        if (!rules.length) {
          await this.editResult(msg, "📭 <b>当前没有自动回复规则</b>");
          return;
        }
        const lines = rules.map((rule, index) =>
          `${index + 1}. <b>${htmlEscape(rule.displayName)}</b>\n` +
          `   群组：<code>${htmlEscape(rule.chatId)}</code>\n` +
          `   用户：<code>${htmlEscape(rule.userId)}</code>\n` +
          `   模式：${rule.mode === "ai" ? "🤖 AI" : "💬 固定"}\n` +
          (rule.mode === "ai"
            ? `   人设：${htmlEscape(rule.aiPersona || "默认")}`
            : `   回复：${htmlEscape(rule.replyText)}`),
        );
        await this.editResult(
          msg,
          `📋 <b>自动回复规则（${rules.length}）</b>\n\n${lines.join("\n\n")}`,
        );
        return;
      }

      if (action === "clear") {
        db.data.rules = {};
        await db.write();
        await this.editResult(msg, "🧹 <b>已清空全部自动回复规则</b>");
        return;
      }

      const replied = await safeGetReplyMessage(msg);
      if (!replied) {
        await this.editResult(msg, helpText);
        return;
      }

      const chatId = this.getChatId(replied) || this.getChatId(msg);
      const userId = this.getUserId(replied);
      if (!chatId || !userId) {
        await this.editResult(msg, "❌ <b>无法识别目标群组或用户</b>");
        return;
      }

      await this.initializeSelf();
      if (this.selfId && userId === this.selfId) {
        await this.editResult(msg, "❌ <b>不能对自己设置自动回复</b>，否则可能形成消息循环。");
        return;
      }

      const key = this.ruleKey(chatId, userId);
      if (action === "off") {
        if (!db.data.rules[key]) {
          await this.editResult(msg, "ℹ️ <b>该用户在当前群组没有自动回复规则</b>");
          return;
        }
        const old = db.data.rules[key];
        delete db.data.rules[key];
        await db.write();
        await this.editResult(
          msg,
          `✅ 已取消 <b>${htmlEscape(old.displayName)}</b> 在当前群组的自动回复`,
        );
        return;
      }

      if (!argument) {
        await this.editResult(msg, helpText);
        return;
      }

      if (argument.length > 1000) {
        await this.editResult(msg, "❌ <b>回复内容过长</b>，最多 1000 个字符。");
        return;
      }

      const name = await this.displayName(replied, userId);
      const aiMatch = argument.match(/^ai(?:\s+([\s\S]+))?$/i);
      const fixedMatch = argument.match(/^fixed\s+([\s\S]+)$/i);
      const mode: "fixed" | "ai" = aiMatch ? "ai" : "fixed";
      const fixedText = fixedMatch ? fixedMatch[1].trim() : argument;
      const aiPersona = aiMatch?.[1]?.trim() || "";
      db.data.rules[key] = {
        chatId,
        userId,
        replyText: mode === "fixed" ? fixedText : "",
        mode,
        aiPersona,
        displayName: name,
        createdAt: new Date().toISOString(),
      };
      await db.write();
      await this.editResult(
        msg,
        `✅ <b>自动回复已开启</b>\n` +
        `├ 用户：<b>${htmlEscape(name)}</b>\n` +
        `├ 群组：<code>${htmlEscape(chatId)}</code>\n` +
        (mode === "ai"
          ? `├ 模式：🤖 <b>AI 每句回复</b>\n└ 人设：${htmlEscape(aiPersona || "默认：自然、轻松、机灵")}`
          : `├ 模式：💬 <b>固定回复</b>\n└ 回复：${htmlEscape(fixedText)}`),
      );
    } catch (error: any) {
      console.error("[AutoReply] Command error:", error);
      await this.editResult(
        msg,
        `❌ <b>设置失败</b>\n<code>${htmlEscape(error?.message || String(error))}</code>`,
      ).catch(() => {});
    }
  }

  private async handleMessage(msg: Api.Message): Promise<void> {
    try {
      if (!msg || (msg as any).out) return;
      const text = msg.message;
      if (!text || !text.trim()) return;

      const chatId = this.getChatId(msg);
      const userId = this.getUserId(msg);
      if (!chatId || !userId) return;

      await this.initializeSelf();
      if (this.selfId && userId === this.selfId) return;

      const sender: any = msg.sender;
      if (sender?.bot) return;

      // Ignore TeleBox-style commands to avoid plugin cascades.
      if (getPrefixes().some((prefix) => text.trimStart().startsWith(prefix))) return;

      const messageKey = `${chatId}:${msg.id}`;
      if (this.processedMessages.has(messageKey)) return;
      this.processedMessages.add(messageKey);
      if (this.processedMessages.size > 2000) {
        const oldest = this.processedMessages.values().next().value;
        if (oldest) this.processedMessages.delete(oldest);
      }

      const db = await this.dbPromise;
      const key = this.ruleKey(chatId, userId);
      const rule = db.data.rules[key];
      if (!rule) return;

      const previous = this.sendQueues.get(key) || Promise.resolve();
      const next = previous
        .catch(() => {})
        .then(async () => {
          const client = await getGlobalClient();
          if (!client) return;
          let replyText = rule.replyText;
          if (rule.mode === "ai") {
            const config = await this.getSumConfig();
            const result = await generateShortReply(config, this.aiSystemPrompt(rule), text.trim());
            replyText = result.content;
          }
          if (!replyText) return;
          await client.sendMessage(msg.peerId, {
            message: replyText,
            replyTo: msg.id,
          });
          console.log(`[AutoReply] mode=${rule.mode || "fixed"} replied to ${rule.displayName} (${userId}) in ${chatId}, msg=${msg.id}`);
        })
        .catch((error: any) => {
          console.warn(`[AutoReply] Reply failed for ${key}: ${error?.message || error}`);
        })
        .finally(() => {
          if (this.sendQueues.get(key) === next) this.sendQueues.delete(key);
        });
      this.sendQueues.set(key, next);
    } catch (error: any) {
      console.warn(`[AutoReply] Listener skipped: ${error?.message || error}`);
    }
  }
}

export default new AutoReplyPlugin();

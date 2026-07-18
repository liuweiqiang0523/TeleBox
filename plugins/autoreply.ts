import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { safeGetReplyMessage } from "@utils/safeGetMessages";
import { Api } from "teleproto";
import { JSONFilePreset } from "lowdb/node";
import path from "path";

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

<b>取消</b>
回复目标用户的一条消息，然后发送：
<code>${mainPrefix}autoreply off</code>

<b>管理</b>
<code>${mainPrefix}autoreply list</code> - 查看全部规则
<code>${mainPrefix}autoreply clear</code> - 清空全部规则

<i>规则按“当前群组 + 目标用户”生效。目标用户每发送一条文字消息，TeleBox 都会引用该消息回复固定内容。</i>`;

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

  cleanup(): void {
    this.sendQueues.clear();
    this.processedMessages.clear();
    this.selfId = null;
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
          `   回复：${htmlEscape(rule.replyText)}`,
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
      db.data.rules[key] = {
        chatId,
        userId,
        replyText: argument,
        displayName: name,
        createdAt: new Date().toISOString(),
      };
      await db.write();
      await this.editResult(
        msg,
        `✅ <b>自动回复已开启</b>\n` +
        `├ 用户：<b>${htmlEscape(name)}</b>\n` +
        `├ 群组：<code>${htmlEscape(chatId)}</code>\n` +
        `└ 回复：${htmlEscape(argument)}`,
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
          await client.sendMessage(msg.peerId, {
            message: rule.replyText,
            replyTo: msg.id,
          });
          console.log(`[AutoReply] Replied to ${rule.displayName} (${userId}) in ${chatId}, msg=${msg.id}`);
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

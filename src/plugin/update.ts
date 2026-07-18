import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { execFile } from "child_process";
import { promisify } from "util";
import { Api } from "teleproto";
import { npm_install_project_dependencies } from "@utils/npm_install";
import { getGlobalClient } from "@utils/runtimeManager";
import { executeExit } from "./reload";
import { updateAllPlugins } from "./tpm";
import { deleteStatusMessage } from "@utils/postReloadMessage";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const execFileAsync = promisify(execFile);
const FORK_REMOTE = "origin";
const MAIN_BRANCH_NAMES = ["main", "master"];

// ── Auto-update state ──────────────────────────────────────────────────
const AUTO_UPDATE_STATE_DIR = path.join(os.homedir(), ".telebox");
const AUTO_UPDATE_STATE_FILE = path.join(AUTO_UPDATE_STATE_DIR, "auto_update.json");

interface AutoUpdateState {
  enabled: boolean;
}

function loadAutoUpdateState(): AutoUpdateState {
  try {
    if (fs.existsSync(AUTO_UPDATE_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(AUTO_UPDATE_STATE_FILE, "utf8"));
    }
  } catch (e: any) {
    console.warn("[auto-update] 读取状态文件失败:", e?.message || e);
  }
  return { enabled: false };
}

function saveAutoUpdateState(state: AutoUpdateState): void {
  try {
    fs.mkdirSync(AUTO_UPDATE_STATE_DIR, { recursive: true });
    fs.writeFileSync(AUTO_UPDATE_STATE_FILE, JSON.stringify(state), "utf8");
  } catch (e: any) {
    console.error("[auto-update] 保存状态文件失败:", e?.message || e);
  }
}

// ── Git helpers ────────────────────────────────────────────────────────
const GIT_USER_NAME = "TeleBox Auto-Update";
const GIT_USER_EMAIL = "telebox@users.noreply.github.com";

async function gitExec(args: string[]): Promise<{ stdout: string; stderr: string }> {
  // Keep Git commands independent from machine-level identity configuration.
  return execFileAsync("git", [
    "-c", `user.name=${GIT_USER_NAME}`,
    "-c", `user.email=${GIT_USER_EMAIL}`,
    ...args,
  ]);
}

async function getRemotes(): Promise<string[]> {
  try {
    const { stdout } = await gitExec(["remote"]);
    return stdout.trim().split("\n").filter((r) => r.trim());
  } catch {
    return [];
  }
}

async function getBranches(): Promise<string[]> {
  try {
    const { stdout } = await gitExec(["branch", "-r"]);
    const branches = stdout
      .trim()
      .split("\n")
      .map((b) => b.trim().replace(/^\*/, "").trim())
      .filter((b) => b && !b.includes("->"));
    return branches;
  } catch {
    return [];
  }
}

async function findForkMainBranch(): Promise<{ remote: string; branch: string } | null> {
  const allRemotes = await getRemotes();
  if (!allRemotes.includes(FORK_REMOTE)) return null;

  await gitExec(["fetch", FORK_REMOTE, "--prune"]);
  const branches = await getBranches();
  for (const branchName of MAIN_BRANCH_NAMES) {
    if (branches.includes(`${FORK_REMOTE}/${branchName}`)) {
      return { remote: FORK_REMOTE, branch: branchName };
    }
  }

  return null;
}

function getErrorMessage(error: any): string {
  if (!error) return "未知错误";
  const errObj = error as Record<string, unknown>;
  return (errObj.stderr as string) || (errObj.message as string) || String(error);
}

// ── Manual update (existing) ───────────────────────────────────────────
async function update(force = false, msg: Api.Message) {
  await msg.edit({ text: "🚀 正在更新项目..." });
  console.clear();
  console.log("🚀 开始更新项目...\n");

  try {
    await msg.edit({ text: "🔄 正在检查维护仓库..." });
    const branchInfo = await findForkMainBranch();
    if (!branchInfo) {
      throw new Error("未找到 origin/main 或 origin/master，请检查 fork 远程仓库配置。");
    }

    const { remote, branch } = branchInfo;
    const fullBranch = `${remote}/${branch}`;

    await msg.edit({ text: "🔄 正在从个人维护仓库拉取最新代码..." });

    if (force) {
      const { stdout: dirtyStd } = await gitExec([
        "status",
        "--porcelain",
        "--untracked-files=no",
      ]);
      const dirtyFiles = dirtyStd
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      if (dirtyFiles.length > 0) {
        const preview = dirtyFiles.slice(0, 10).join("\n");
        throw new Error(
          `检测到 ${dirtyFiles.length} 个未提交的受控文件改动，已阻止强制更新，避免覆盖服务器维护内容：\n${preview}`
        );
      }

      const { stdout: aheadStd } = await gitExec([
        "rev-list",
        "--count",
        `${fullBranch}..HEAD`,
      ]);
      const aheadCount = Number(aheadStd.trim() || "0");
      if (aheadCount > 0) {
        throw new Error(
          `当前分支有 ${aheadCount} 个本地维护提交，已阻止强制更新，避免丢失服务器定制改动。请手动合并或联系维护。`
        );
      }

      console.log(`⚠️ 强制回滚到 ${fullBranch}...`);
      await gitExec(["reset", "--hard", fullBranch]);
      await msg.edit({ text: "🔄 强制更新中..." });
    }

    await gitExec(["pull", "--ff-only", remote, branch]);
    await msg.edit({ text: "🔄 已同步个人维护仓库，正在完成更新..." });

    console.log("\n📦 安装依赖...");
    await msg.edit({ text: "📦 正在安装依赖..." });
    await npm_install_project_dependencies();

    console.log("\n✅ 更新完成。");

    await executeExit(msg, {
      pendingText: "🔄 正在重启进程...",
      successText: "✅ 更新完成，耗时 {elapsedMs}ms",
    });
  } catch (error: any) {
    console.error("❌ 更新失败:", error);

    const errCmd = error.cmd || "";
    const errDetail = error.stderr || error.message || String(error);

    const errorText =
      `❌ 更新失败\n` +
      (errCmd ? `失败命令行：${errCmd}\n` : "") +
      `失败原因：${errDetail}\n\n` +
      "更新仅从个人维护仓库 origin 获取。请先检查 GitHub Actions 的 Sync upstream；不要直接在服务器合并 upstream。";

    try {
      await msg.edit({ text: errorText });
    } catch (editError) {
      console.error("Failed to send error message after update failure:", editError);
      try {
        const client = await getGlobalClient();
        const targetChat = msg.chatId || msg.peerId;
        if (client && targetChat) {
          await client.sendMessage(targetChat, { message: errorText });
        }
      } catch (sendError) {
        console.error("Failed to send error via fallback client:", sendError);
      }
    }
  }
}

// ── Auto-update for main repo ──────────────────────────────────────────
async function autoUpdateMainRepo(githubMsg: Api.Message): Promise<void> {
  let statusMsg: Api.Message | undefined;
  try {
    statusMsg = await githubMsg.reply({ message: "🤖 自动更新：检测到主仓库新提交，正在更新…" });
    if (!statusMsg) throw new Error("无法发送状态消息");

    // Snapshot peerId+msgId before any blocking operation — npm_install_project_dependencies()
    // uses execFileSync (synchronous), which blocks the event loop and can cause the teleproto
    // connection to drop. After that, statusMsg._client is stale and statusMsg.delete() fails
    // silently (caught by catch(_){}). Same root cause as the plugin auto-update bug (21de22c).
    // Prefer marked chat id string — survives entity-cache wipe after npm/reload
    const targetPeerId = normalizeChatId(statusMsg) || statusMsg.peerId;
    const targetMsgId = statusMsg.id;

    const branchInfo = await findForkMainBranch();
    if (!branchInfo) {
      throw new Error("未找到个人维护仓库 origin/main 或 origin/master");
    }
    const { remote, branch } = branchInfo;

    await gitExec(["pull", "--ff-only", remote, branch]);
    await npm_install_project_dependencies();

    // Success — delete status message using a fresh client, then restart silently.
    // statusMsg.delete() may fail because the client connection died during npm install.
    await deleteStatusMessage(targetPeerId, targetMsgId);
    await executeAutoExit();
  } catch (error: any) {
    const errDetail = getErrorMessage(error);
    if (statusMsg) {
      try {
        await statusMsg.edit({ text: `❌ 自动更新失败：${errDetail}` });
      } catch (_) {}
    } else {
      try { await githubMsg.reply({ message: `❌ 自动更新失败：${errDetail}` }); } catch (_) {}
    }
  }
}

/**
 * Delete a status message using a fresh client — see
 * @utils/postReloadMessage.deleteStatusMessage.
 */

async function executeAutoExit(): Promise<void> {
  // Minimal restart: just exit the process. pm2 will restart it.
  // No message tracking needed — we already deleted the status message.
  console.log("[auto-update] 更新完成，退出进程…");
  process.exit(0);
}

// ── Auto-update for plugin repos ───────────────────────────────────────
async function autoUpdatePlugins(githubMsg: Api.Message): Promise<void> {
  try {
    const statusMsg = (await githubMsg.reply({ message: "🤖 自动更新：检测到插件仓库新提交，正在更新插件…" }))!;
    // Snapshot before updateAllPlugins → reloadAndFinalize → loadPlugins()
    // (plugin reload invalidates statusMsg's internal _client reference)
    const fallbackPeerId = normalizeChatId(statusMsg) || statusMsg.peerId;
    const fallbackMsgId = statusMsg.id;

    const result = await updateAllPlugins(statusMsg);

    if (result.failedCount === 0) {
      const targetPeerId = result.statusPeerId ?? fallbackPeerId;
      const targetMsgId = result.statusMsgId ?? fallbackMsgId;
      await deleteStatusMessage(targetPeerId, targetMsgId);
    }
  } catch (error: any) {
    console.error("[auto-update] 插件更新异常:", getErrorMessage(error));
  }
}

// ── GitHubBot message parsing ──────────────────────────────────────────
// Channel: GitHub commit notifications (hardcoded product channel)
const GITHUB_CHANNEL_ID = "-1003061608291";
// GitHubBot user id (stable; username may be missing on live NewMessage events)
const GITHUB_BOT_USER_ID = "107550100";
const GITHUB_BOT_USERNAME = "githubbot";

// Real bot text (2026-07): "🔨 1 new commit to TeleBox:main:\n\n28d6511: …"
// Also accept optional TeleBoxOrg/ prefix and legacy TeleBox_M names.
const MAIN_REPO_PATTERN =
  /new commit[\s\S]*?to\s+(?:TeleBoxOrg\/)?(TeleBox|TeleBox_M|TeleBox-Next)\s*:\s*main/i;
const PLUGIN_REPO_PATTERN =
  /new commit[\s\S]*?to\s+(?:TeleBoxOrg\/)?(TeleBox_Plugins|TeleBox_M_Plugins|TeleBox-Next_Plugins)\s*:\s*main/i;

function normalizeChatId(msg: Api.Message): string {
  if (msg.chatId != null) return String(msg.chatId);
  const peer = msg.peerId as
    | { className?: string; channelId?: { toString(): string }; userId?: { toString(): string }; chatId?: { toString(): string } }
    | undefined;
  if (peer?.channelId != null) return `-100${String(peer.channelId)}`;
  if (peer?.userId != null) return String(peer.userId);
  if (peer?.chatId != null) {
    const id = String(peer.chatId);
    return id.startsWith("-") ? id : `-${id}`;
  }
  return "";
}

function isGitHubBot(msg: Api.Message): boolean {
  const sid = msg.senderId != null ? String(msg.senderId) : "";
  if (sid && sid === GITHUB_BOT_USER_ID) return true;
  const uname = String((msg.sender as { username?: string } | undefined)?.username || "")
    .toLowerCase()
    .replace(/^@/, "");
  if (uname === GITHUB_BOT_USERNAME) return true;
  // fromId PeerUser fallback when sender entity not hydrated
  const from = msg.fromId as { userId?: { toString(): string } } | undefined;
  if (from?.userId != null && String(from.userId) === GITHUB_BOT_USER_ID) return true;
  return false;
}

class UpdatePlugin extends Plugin {
  description: string =
    `更新项目：从个人维护仓库拉取已验证代码并安装依赖\n` +
    `<code>${mainPrefix}update -f/-force</code> 强制更新\n` +
    `<code>${mainPrefix}update auto on</code> / <code>off</code> 自动更新开关（默认关闭）`;

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    update: async (msg) => {
      const parts = msg.message.slice(1).split(" ").slice(1);

      // update auto on/off
      if (parts[0] === "auto") {
        const sub = parts[1]?.toLowerCase();
        if (sub === "on") {
          saveAutoUpdateState({ enabled: true });
          await msg.edit({ text: "✅ 自动更新已开启\n\n检测到维护仓库提交时，从 origin 快进更新并重启；插件仓库提交仍使用 tpm update。" });
          return;
        }
        if (sub === "off") {
          saveAutoUpdateState({ enabled: false });
          await msg.edit({ text: "🔒 自动更新已关闭" });
          return;
        }
        // show status
        const state = loadAutoUpdateState();
        await msg.edit({ text: `自动更新状态：${state.enabled ? "✅ 开启" : "🔒 关闭"}\n\n使用 <code>${mainPrefix}update auto on/off</code> 切换` });
        return;
      }

      const force = parts.includes("--force") || parts.includes("-f");
      await update(force, msg);
    },
  };

  listenMessageHandler = async (msg: Api.Message): Promise<void> => {
    const state = loadAutoUpdateState();
    if (!state.enabled) return;

    const chatId = normalizeChatId(msg);
    if (chatId !== GITHUB_CHANNEL_ID) return;

    if (!isGitHubBot(msg)) return;

    const text = msg.message || "";
    if (!text || !/new commit/i.test(text)) return;

    // Plugin repos first — "TeleBox_Plugins" also contains substring "TeleBox"
    if (PLUGIN_REPO_PATTERN.test(text)) {
      console.log("[auto-update] 检测到插件仓库提交，开始自动更新插件…");
      await autoUpdatePlugins(msg);
    } else if (MAIN_REPO_PATTERN.test(text)) {
      console.log("[auto-update] 检测到主仓库提交，开始自动更新…");
      await autoUpdateMainRepo(msg);
    }
  };
}

export default new UpdatePlugin();

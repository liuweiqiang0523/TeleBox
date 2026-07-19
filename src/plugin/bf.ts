import { Plugin, type PluginRuntimeContext } from "@utils/pluginBase";
import { Api } from "teleproto";
import { safeGetMessages } from "@utils/safeGetMessages";
import { getGlobalClient } from "@utils/runtimeManager";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as os from "os";
import { spawn, type ChildProcess } from "child_process";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import { getPrefixes } from "@utils/pluginManager";
import type { GenerationContext } from "@utils/generationContext";
import { tryGetCurrentGenerationContext } from "@utils/runtimeManager";
import { CustomFile } from "teleproto/client/uploads";
import bigInt, { BigInteger } from "big-integer";
import { htmlEscape } from "@utils/htmlEscape";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
// 时区设置
const CN_TIME_ZONE = "Asia/Shanghai";
const BACKUP_UPLOAD_TIMEOUT_MS = 900_000;
const BACKUP_UPLOAD_STALL_MS = 120_000;
const BACKUP_PART_TIMEOUT_MS = 30_000;
const BACKUP_PART_RETRY_LIMIT = 4;
const SMALL_FILE_LIMIT_BYTES = 10 * 1024 * 1024;
const SMALL_UPLOAD_PART_SIZE = 512 * 1024;
const BACKUP_UPLOAD_WORKERS = 1;
const PORTABLE_BACKUP_FORMAT_VERSION = 2;
const BACKUP_MANIFEST_NAME = "telebox_backup_manifest.json";

// 标准备份排除项（旧版兼容）
const STANDARD_BACKUP_EXCLUDES = new Set([
  path.join("assets", "ytdlp", "yt-dlp"),
  path.join("assets", "speedtest", "speedtest"),
]);

// 可移植备份额外排除模式
const PORTABLE_EXCLUDE_PATTERNS = [
  /^node_modules(\/|$)/,
  /^\.git(\/|$)/,
  /^my_session(\/|$)/,
  /^temp(\/|$)/,
  /^logs(\/|$)/,
  /^backups(\/|$)/,
  /^_restore_backup_.*$/,
  /\.bak$/,
  /\.bak-.*$/,
  /_backup_.*$/,
  /~$/,
  /^assets\/ytdlp\/yt-dlp$/,
  /^assets\/speedtest\/speedtest$/,
];

function formatCN(date: Date): string {
  return date.toLocaleString("zh-CN", { timeZone: CN_TIME_ZONE });
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时 (${Math.round(ms / 1000)}s)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function describeDestination(dest: any, display: string): string {
  if (dest === "me") return "收藏夹 (Saved Messages)";
  return display || `<code>${String(dest)}</code>`;
}

function getUploadDestination(dest: any): any {
  return dest === "me" ? new Api.InputPeerSelf() : dest;
}

function isMessageNotModifiedError(error: any): boolean {
  const message = String(error?.message || error || "");
  return (
    message.includes("MESSAGE_NOT_MODIFIED") ||
    message.includes("MessageNotModifiedError") ||
    message.includes("message data is identical")
  );
}

async function safeEditMessage(
  msg: Api.Message,
  options: { text: string; parseMode?: string }
): Promise<void> {
  try {
    await msg.edit(options);
  } catch (error) {
    if (isMessageNotModifiedError(error)) return;
    throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createUploadFileId(): BigInteger {
  return bigInt(crypto.randomBytes(7).toString("hex"), 16);
}

async function reconnectClient(client: any): Promise<void> {
  try {
    if (typeof client.disconnect === "function") {
      await client.disconnect();
    }
  } catch {}
  await sleep(1500);
  try {
    if (typeof client.connect === "function") {
      await client.connect();
    }
  } catch {}
}

async function uploadSmallFileWithRetries(
  client: any,
  backupPath: string,
  sizeBytes: number,
  onProgress: (progress: number) => void
): Promise<Api.InputFile> {
  const name = path.basename(backupPath);
  const fileId = createUploadFileId();
  const partCount = Math.ceil(sizeBytes / SMALL_UPLOAD_PART_SIZE);
  const handle = await fs.promises.open(backupPath, "r");

  try {
    for (let part = 0; part < partCount; part += 1) {
      const start = part * SMALL_UPLOAD_PART_SIZE;
      const length = Math.min(SMALL_UPLOAD_PART_SIZE, sizeBytes - start);
      const bytes = Buffer.alloc(length);
      await handle.read(bytes, 0, length, start);

      let sent = false;
      let lastError: unknown;
      for (let attempt = 1; attempt <= BACKUP_PART_RETRY_LIMIT; attempt += 1) {
        try {
          await withTimeout(
            client.invoke(
              new Api.upload.SaveFilePart({
                fileId,
                filePart: part,
                bytes,
              })
            ),
            BACKUP_PART_TIMEOUT_MS,
            `上传分片 ${part + 1}/${partCount}`
          );
          sent = true;
          break;
        } catch (error) {
          lastError = error;
          console.warn(
            `[bf] upload part ${part + 1}/${partCount} attempt ${attempt} failed: ${String(error)}`
          );
          if (attempt < BACKUP_PART_RETRY_LIMIT) {
            await reconnectClient(client);
          }
        }
      }

      if (!sent) {
        throw new Error(`上传分片 ${part + 1}/${partCount} 失败: ${String(lastError)}`);
      }

      onProgress((part + 1) / partCount);
    }
  } finally {
    await handle.close().catch(() => {});
  }

  return new Api.InputFile({
    id: fileId,
    parts: partCount,
    name,
    md5Checksum: "",
  });
}

async function uploadBackupFile(
  client: any,
  msg: Api.Message,
  dest: any,
  destDisplay: string,
  backupPath: string,
  caption: string,
  sizeBytes: number
): Promise<void> {
  const uploadDest = getUploadDestination(dest);
  const file = new CustomFile(path.basename(backupPath), sizeBytes, backupPath);
  let lastProgress = 0;
  let lastProgressAt = Date.now();
  let lastEditAt = 0;

  const editProgress = async (progress: number, phase = "上传中") => {
    const now = Date.now();
    const percent = Math.max(0, Math.min(100, Math.floor(progress * 100)));
    if (now - lastEditAt < 12_000 && percent < 100) return;
    lastEditAt = now;
    await safeEditMessage(msg, {
      text:
        `📤 正在上传备份...\n\n` +
        `🎯 目标: ${destDisplay}\n` +
        `📦 大小: ${(sizeBytes / 1024 / 1024).toFixed(2)} MB\n` +
        `📈 进度: ${percent}%\n` +
        `🧩 阶段: ${phase}`,
      parseMode: "html",
    });
  };

  const progressCallback = (progress: number) => {
    if (progress > lastProgress) {
      lastProgress = progress;
      lastProgressAt = Date.now();
      void editProgress(progress).catch(() => {});
    }
  };

  const stallWatch = setInterval(() => {
    if (Date.now() - lastProgressAt > BACKUP_UPLOAD_STALL_MS) {
      (progressCallback as any).isCanceled = true;
    }
  }, 10_000);

  try {
    await editProgress(0, "准备上传");
    const fileHandle = sizeBytes < SMALL_FILE_LIMIT_BYTES
      ? await uploadSmallFileWithRetries(client, backupPath, sizeBytes, progressCallback)
      : await withTimeout(
          client.uploadFile({
            file,
            workers: BACKUP_UPLOAD_WORKERS,
            onProgress: progressCallback,
            maxBufferSize: 8 * 1024 * 1024,
          }),
          BACKUP_UPLOAD_TIMEOUT_MS,
          `上传到 ${dest}`
        );

    if ((progressCallback as any).isCanceled) {
      throw new Error(`上传到 ${dest} 长时间无进度 (${Math.round(BACKUP_UPLOAD_STALL_MS / 1000)}s)`);
    }

    await editProgress(1, "发送文件消息");
    await withTimeout(
      client.sendFile(uploadDest, {
        file: fileHandle,
        caption,
        forceDocument: true,
        parseMode: "html",
      }),
      120_000,
      `发送到 ${dest}`
    );
  } finally {
    clearInterval(stallWatch);
  }
}

async function formatEntity(
  target: any,
  mention?: boolean,
  throwErrorIfFailed?: boolean
) {
  const client = await getGlobalClient();
  if (!client) throw new Error("Telegram 客户端未初始化");
  if (!target) throw new Error("无效的目标");
  let id: any;
  let entity: any;
  try {
    entity = target?.className
      ? target
      : ((await client?.getEntity(target)) as any);
    if (!entity) throw new Error("无法获取 entity");
    id = entity.id;
    if (!id) throw new Error("无法获取 entity id");
  } catch (e: any) {
    console.error(e);
    if (throwErrorIfFailed)
      throw new Error(
        `无法获取 ${target} 的 entity: ${e?.message || "未知错误"}`
      );
  }
  const displayParts: string[] = [];

  if (entity?.title) displayParts.push(htmlEscape(entity.title));
  if (entity?.firstName) displayParts.push(htmlEscape(entity.firstName));
  if (entity?.lastName) displayParts.push(htmlEscape(entity.lastName));
  if (entity?.username)
    displayParts.push(
      mention ? `@${htmlEscape(entity.username)}` : `<code>@${htmlEscape(entity.username)}</code>`
    );

  if (id) {
    displayParts.push(
      entity instanceof Api.User
        ? `<a href="tg://user?id=${id}">${id}</a>`
        : `<a href="https://t.me/c/${id}">${id}</a>`
    );
  } else if (!target?.className) {
    displayParts.push(`<code>${htmlEscape(target)}</code>`);
  }

  return {
    id,
    entity,
    display: displayParts.join(" ").trim(),
  };
}

// 类型定义
interface BackupConfig {
  target_chat_ids: string[];
}

interface FileInfo {
  file_name: string;
  file_size: number;
  message_id: number;
  chat_id: number;
  date: string;
}

interface BackupManifest {
  formatVersion: number;
  backupType: string;
  createdAt: string;
  teleboxVersion: string;
  nodeVersion: string;
  gitCommit?: string;
  gitBranch?: string;
  includes: string[];
  fileCount: number;
  totalRawSize: number;
  sha256: string;
  files: Array<{
    path: string;
    size: number;
    sha256: string;
  }>;
}

// 配置管理类
class ConfigManager {
  private static db: Low<BackupConfig> | null = null;

  static async getDB(): Promise<Low<BackupConfig>> {
    if (!this.db) {
      const configDir = createDirectoryInAssets("bf");
      const configPath = path.join(configDir, "bf_config.json");
      const adapter = new JSONFile<BackupConfig>(configPath);
      this.db = new Low<BackupConfig>(adapter, { target_chat_ids: [] });
      await this.db.read();
    }
    return this.db;
  }

  static async getTargets(): Promise<string[]> {
    const db = await this.getDB();
    return db.data.target_chat_ids || [];
  }

  static async setTargets(targets: string[]): Promise<void> {
    const db = await this.getDB();
    db.data.target_chat_ids = targets;
    await db.write();
  }

  static async addTargets(newTargets: string[]): Promise<string[]> {
    const current = await this.getTargets();
    const combined = [...new Set([...current, ...newTargets])];
    await this.setTargets(combined);
    return combined;
  }

  static async removeTarget(target: string): Promise<string[]> {
    if (target === "all") {
      await this.setTargets([]);
      return [];
    }
    const current = await this.getTargets();
    const filtered = current.filter((t) => t !== target);
    await this.setTargets(filtered);
    return filtered;
  }

  static cleanup(): void {
    this.db = null;
  }
}

// 工具函数
function sanitizeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9_.-]/g, "_").substring(0, 100);
}

function generateBackupName(): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+/, "")
    .replace("T", "_");
  const randomId = crypto.randomBytes(4).toString("hex");
  return sanitizeFilename(`telebox_backup_${timestamp}_${randomId}.tar.gz`);
}

function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  if (typeof reason === "string") return new Error(reason);
  return new Error("Backup operation aborted");
}

function throwIfAborted(lifecycle: GenerationContext): void {
  if (lifecycle.signal.aborted) {
    throw abortError(lifecycle.signal.reason);
  }
}

function trackChildProcess<T extends ChildProcess>(
  child: T,
  lifecycle: GenerationContext,
  label: string
): T {
  return lifecycle.trackChildProcess(child, { label }) as T;
}

function hashFile(filePath: string): string {
  const hash = crypto.createHash("sha256");
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest("hex");
}

function hashString(data: string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function shouldExclude(relPath: string): boolean {
  const posixPath = relPath.split(path.sep).join("/");
  return PORTABLE_EXCLUDE_PATTERNS.some((pattern) => pattern.test(posixPath));
}

function getGitInfo(programDir: string): { commit?: string; branch?: string } {
  try {
    const commit = spawn("git", ["-C", programDir, "rev-parse", "--short", "HEAD"])
      .stdout?.toString().trim();
    const branch = spawn("git", ["-C", programDir, "rev-parse", "--abbrev-ref", "HEAD"])
      .stdout?.toString().trim();
    return { commit, branch };
  } catch {
    return {};
  }
}

// 递归复制目录（支持排除）
function copyDirRecursive(
  src: string,
  dest: string,
  options: { root?: string; excludeRelPaths?: Set<string> } = {}
): void {
  const relPath = options.root
    ? path.relative(options.root, src).split(path.sep).join(path.posix.sep)
    : "";
  if (relPath && options.excludeRelPaths?.has(relPath)) {
    return;
  }

  fs.mkdirSync(dest, { recursive: true });

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    const entryRelPath = options.root
      ? path.relative(options.root, srcPath).split(path.sep).join(path.posix.sep)
      : "";

    if (entryRelPath && options.excludeRelPaths?.has(entryRelPath)) {
      continue;
    }

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath, options);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// 创建可移植备份
async function createPortableBackup(
  programDir: string,
  outputPath: string,
  lifecycle: GenerationContext,
  options: { includeSession?: boolean } = {}
): Promise<{ fileCount: number; totalRawSize: number }> {
  const tempDir = path.join(os.tmpdir(), `backup_${crypto.randomBytes(8).toString("hex")}`);
  const backupDir = path.join(tempDir, "telebox_backup");

  try {
    fs.mkdirSync(backupDir, { recursive: true });

    // 1. 复制核心目录
    const dirsToCopy = ["plugins", "assets"];
    for (const dir of dirsToCopy) {
      const src = path.join(programDir, dir);
      if (!fs.existsSync(src)) continue;
      const dest = path.join(backupDir, dir);
      copyDirRecursive(src, dest, { root: programDir, excludeRelPaths: STANDARD_BACKUP_EXCLUDES });
    }

    // 2. 复制配置文件
    const configFiles = ["config.json", "package.json", "package-lock.json", "tsconfig.json"];
    for (const f of configFiles) {
      const src = path.join(programDir, f);
      if (fs.existsSync(src)) {
        if (f === "config.json" && options.includeSession === false) {
          // 创建无 session 的 config 副本
          const cfg = JSON.parse(fs.readFileSync(src, "utf8"));
          const stripped = { api_id: cfg.api_id, api_hash: cfg.api_hash };
          fs.writeFileSync(path.join(backupDir, f), JSON.stringify(stripped, null, 2));
        } else {
          fs.copyFileSync(src, path.join(backupDir, f));
        }
      }
    }

    // 3. 复制 .env 文件
    const envFiles = fs.readdirSync(programDir).filter((f) => f.startsWith(".env"));
    for (const f of envFiles) {
      fs.copyFileSync(path.join(programDir, f), path.join(backupDir, f));
    }

    // 4. 生成清单
    const fileList: Array<{ path: string; size: number; sha256: string }> = [];
    let totalRawSize = 0;
    let fileCount = 0;

    function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(backupDir, fullPath).split(path.sep).join("/");
        if (shouldExclude(relPath)) continue;
        if (entry.isDirectory()) {
          walk(fullPath);
        } else {
          const size = fs.statSync(fullPath).size;
          fileList.push({ path: relPath, size, sha256: hashFile(fullPath) });
          totalRawSize += size;
          fileCount++;
        }
      }
    }
    walk(backupDir);

    const gitInfo = getGitInfo(programDir);
    const pkg = JSON.parse(fs.readFileSync(path.join(programDir, "package.json"), "utf8"));

    const manifest: BackupManifest = {
      formatVersion: PORTABLE_BACKUP_FORMAT_VERSION,
      backupType: "portable",
      createdAt: new Date().toISOString(),
      teleboxVersion: pkg.version || "unknown",
      nodeVersion: process.version,
      gitCommit: gitInfo.commit,
      gitBranch: gitInfo.branch,
      includes: [...dirsToCopy, ...configFiles, ...envFiles],
      fileCount,
      totalRawSize,
      sha256: "", // 占位，稍后计算
      files: fileList,
    };

    const manifestPath = path.join(backupDir, BACKUP_MANIFEST_NAME);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    manifest.sha256 = hashString(JSON.stringify(manifest));
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    // 5. 创建 tar.gz
    await lifecycle.runTask(
      async () =>
        await new Promise<void>((resolve, reject) => {
          const tar = trackChildProcess(spawn("tar", [
            "-czf", outputPath, "-C", tempDir, "telebox_backup",
          ]), lifecycle, "bf:create-portable-tar");

          tar.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`tar exited with code ${code}`));
          });
          tar.on("error", reject);
          throwIfAborted(lifecycle);
        }),
      { label: "bf:create-portable-tar" }
    );

    return { fileCount, totalRawSize };
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      console.warn(`[bf] 临时目录清理失败: ${String(cleanupErr)}`);
    }
  }
}

// 创建标准备份（旧版兼容）
async function createBackup(
  dirs: string[],
  outputPath: string,
  lifecycle: GenerationContext,
  excludeRelPaths: Set<string> = new Set()
): Promise<void> {
  const tempDir = path.join(os.tmpdir(), `backup_${crypto.randomBytes(8).toString("hex")}`);
  const backupDir = path.join(tempDir, "telebox_backup");

  try {
    fs.mkdirSync(backupDir, { recursive: true });

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      const baseName = path.basename(dir);
      const targetDir = path.join(backupDir, baseName);
      copyDirRecursive(dir, targetDir, { root: path.dirname(dir), excludeRelPaths });
    }

    await lifecycle.runTask(
      async () =>
        await new Promise<void>((resolve, reject) => {
          const tar = trackChildProcess(spawn("tar", [
            "-czf", outputPath, "-C", tempDir, "telebox_backup",
          ]), lifecycle, "bf:create-tar");

          tar.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`tar exited with code ${code}`));
          });
          tar.on("error", reject);
          throwIfAborted(lifecycle);
        }),
      { label: "bf:create-tar" }
    );
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      console.warn(`[bf] 临时目录清理失败: ${String(cleanupErr)}`);
    }
  }
}

// 校验备份完整性
async function verifyBackup(
  archivePath: string,
  lifecycle: GenerationContext
): Promise<{ valid: boolean; manifest?: BackupManifest; error?: string }> {
  // 1. gzip 测试
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("gzip", ["-t", archivePath]);
      proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`gzip test failed: ${code}`)));
      proc.on("error", reject);
    });
  } catch (e) {
    return { valid: false, error: `gzip 校验失败: ${String(e)}` };
  }

  // 2. tar 列表测试
  let tarList: string;
  try {
    tarList = await new Promise<string>((resolve, reject) => {
      let output = "";
      const proc = spawn("tar", ["-tzf", archivePath]);
      proc.stdout.on("data", (d) => (output += d.toString()));
      proc.on("close", (code) => code === 0 ? resolve(output) : reject(new Error(`tar list failed: ${code}`)));
      proc.on("error", reject);
    });
  } catch (e) {
    return { valid: false, error: `tar 列表失败: ${String(e)}` };
  }

  const lines = tarList.trim().split("\n");
  const hasManifest = lines.some((l) => l.includes(BACKUP_MANIFEST_NAME));

  if (!hasManifest) {
    // 旧版备份，无清单
    const hasPlugins = lines.some((l) => l.startsWith("telebox_backup/plugins/"));
    const hasAssets = lines.some((l) => l.startsWith("telebox_backup/assets/"));
    if (!hasPlugins && !hasAssets) {
      return { valid: false, error: "备份中未找到 plugins 或 assets" };
    }
    return { valid: true, error: undefined };
  }

  // 3. 提取并验证清单
  const tempDir = path.join(os.tmpdir(), `verify_${Date.now()}`);
  try {
    fs.mkdirSync(tempDir, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("tar", ["-xzf", archivePath, "-C", tempDir, `--telebox_backup/${BACKUP_MANIFEST_NAME}`]);
      proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`extract manifest failed: ${code}`)));
      proc.on("error", reject);
    });

    const manifestPath = path.join(tempDir, "telebox_backup", BACKUP_MANIFEST_NAME);
    if (!fs.existsSync(manifestPath)) {
      return { valid: false, error: "无法提取清单文件" };
    }

    const manifest: BackupManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (manifest.formatVersion !== PORTABLE_BACKUP_FORMAT_VERSION) {
      return { valid: false, error: `不支持的备份格式版本: ${manifest.formatVersion}` };
    }

    // 验证必需文件存在
    const requiredPaths = manifest.files.map((f) => `telebox_backup/${f.path}`);
    for (const rp of requiredPaths) {
      if (!lines.some((l) => l === rp || l === rp + "/")) {
        return { valid: false, error: `备份中缺少文件: ${rp}` };
      }
    }

    return { valid: true, manifest, error: undefined };
  } catch (e) {
    return { valid: false, error: `清单验证失败: ${String(e)}` };
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}

// 安全解压（防止路径穿越）
async function safeExtract(
  archivePath: string,
  extractDir: string,
  lifecycle: GenerationContext
): Promise<string> {
  await lifecycle.runTask(
    async () =>
      await new Promise<void>((resolve, reject) => {
        const tar = trackChildProcess(
          spawn("tar", ["-xzf", archivePath, "-C", extractDir]),
          lifecycle,
          "bf:extract-tar"
        );
        tar.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`tar exited with code ${code}`));
        });
        tar.on("error", reject);
        throwIfAborted(lifecycle);
      }),
    { label: "bf:extract-tar" }
  );

  const backupRoot = path.join(extractDir, "telebox_backup");
  if (!fs.existsSync(backupRoot)) {
    throw new Error("无效的备份文件格式：缺少 telebox_backup 目录");
  }

  // 路径穿越检查
  function checkTraversal(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      const realPath = fs.realpathSync(fullPath);
      if (!realPath.startsWith(path.resolve(extractDir))) {
        throw new Error(`检测到路径穿越: ${entry.name}`);
      }
      if (entry.isDirectory()) checkTraversal(fullPath);
    }
  }
  checkTraversal(backupRoot);

  return backupRoot;
}

// 事务式恢复备份
async function restorePortableBackup(
  backupRoot: string,
  programDir: string,
  lifecycle: GenerationContext
): Promise<{ needsRestart: boolean; rollbackDir: string }> {
  const manifestPath = path.join(backupRoot, BACKUP_MANIFEST_NAME);
  let manifest: BackupManifest | undefined;
  if (fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  }

  // 1. 创建当前状态回滚备份
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
  const rollbackDir = path.join(programDir, `_restore_backup_${timestamp}`);
  fs.mkdirSync(rollbackDir, { recursive: true });

  const dirsToRestore = manifest
    ? manifest.includes.filter((inc) => fs.existsSync(path.join(backupRoot, inc)))
    : ["plugins", "assets"];

  for (const dir of dirsToRestore) {
    const currentPath = path.join(programDir, dir);
    if (fs.existsSync(currentPath)) {
      copyDirRecursive(currentPath, path.join(rollbackDir, dir));
    }
  }

  // 2. 校验文件哈希（可移植备份）
  if (manifest) {
    for (const fileInfo of manifest.files) {
      const srcPath = path.join(backupRoot, fileInfo.path);
      if (!fs.existsSync(srcPath)) {
        throw new Error(`备份文件缺失: ${fileInfo.path}`);
      }
      const actualHash = hashFile(srcPath);
      if (actualHash !== fileInfo.sha256) {
        throw new Error(`文件哈希不匹配: ${fileInfo.path}`);
      }
    }
  }

  // 3. 恢复到生产目录
  for (const dir of dirsToRestore) {
    const currentPath = path.join(programDir, dir);
    const backupPath = path.join(backupRoot, dir);

    if (fs.existsSync(currentPath)) {
      fs.rmSync(currentPath, { recursive: true, force: true });
    }
    if (fs.existsSync(backupPath)) {
      copyDirRecursive(backupPath, currentPath);
    }
  }

  console.log(`[bf] 恢复完成，原文件备份在: ${rollbackDir}`);
  return { needsRestart: true, rollbackDir };
}

// 旧版恢复函数（兼容）
async function restoreBackup(extractPath: string): Promise<void> {
  const programDir = process.cwd();
  const backupRoot = path.join(extractPath, "telebox_backup");

  if (!fs.existsSync(backupRoot)) {
    throw new Error("无效的备份文件格式");
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
  const currentBackupDir = path.join(programDir, `_restore_backup_${timestamp}`);
  fs.mkdirSync(currentBackupDir, { recursive: true });

  const dirs = ["plugins", "assets"];
  for (const dir of dirs) {
    const currentPath = path.join(programDir, dir);
    const backupPath = path.join(backupRoot, dir);
    const savePath = path.join(currentBackupDir, dir);

    if (fs.existsSync(currentPath)) {
      copyDirRecursive(currentPath, savePath);
      fs.rmSync(currentPath, { recursive: true, force: true });
    }
    if (fs.existsSync(backupPath)) {
      copyDirRecursive(backupPath, currentPath);
    }
  }

  console.log(`恢复完成，原文件备份在: ${currentBackupDir}`);
}

const help_text = `<code>${mainPrefix}bf</code> 可移植备份（含插件、配置、Session，换服务器可直接恢复）
<code>${mainPrefix}bf all</code> - 备份整个程序（排除node_modules等）
<code>${mainPrefix}bf light</code> - 轻量备份（仅 plugins + assets，旧版兼容）
<code>${mainPrefix}bf nosession</code> - 可移植备份但不包含 Telegram Session
<code>${mainPrefix}bf set 对话ID</code> - 设置备份发送到的目标对话
<code>${mainPrefix}bf to 对话ID</code> - 仅本次备份发送到目标对话
<code>${mainPrefix}bf del 对话ID/all</code> - 删除备份发送到的目标对话
<code>${mainPrefix}hf</code> 恢复备份`;

// 插件类
class BfPlugin extends Plugin {
  private lifecycle: GenerationContext | null = null;

  setup(context: PluginRuntimeContext): void {
    this.lifecycle = context.lifecycle;
  }

  cleanup(): void {
    this.lifecycle = null;
    ConfigManager.cleanup();
  }

  private getLifecycle(): GenerationContext {
    let lifecycle = this.lifecycle;
    if (!lifecycle || lifecycle.signal.aborted) {
      const fallback = tryGetCurrentGenerationContext();
      if (fallback && !fallback.signal.aborted) {
        this.lifecycle = fallback;
        lifecycle = fallback;
      }
    }
    if (!lifecycle) {
      throw new Error("Backup plugin lifecycle is not initialized");
    }
    throwIfAborted(lifecycle);
    return lifecycle;
  }

  description = `\n📦 备份插件\n\n${help_text}\n\n可移植备份包含：plugins、assets、config.json（含Session）、package.json、.env\n换服务器后只需在新服务器装好 TeleBox，回复备份发送 .hf 即可恢复全部设置。`;

  cmdHandlers = {
    bf: async (msg: Api.Message) => {
      const lifecycle = this.getLifecycle();
      const args = msg.message.slice(1).split(" ").slice(1);
      const cmd = args[0] || "";

      // 设置目标
      if (cmd === "set") {
        if (args.length < 2) {
          await msg.edit({ text: help_text, parseMode: "html" });
          return;
        }
        const ids = args.slice(1).join(" ").replace(/,/g, " ").split(/\s+/).filter(Boolean);
        const valid = ids.map((id) => (/^100\d+$/.test(id) ? `-${id}` : id)).filter((id) => /^-?\d+$/.test(id));
        if (valid.length === 0) {
          await msg.edit({ text: "❌ 无效的聊天ID", parseMode: "html" });
          return;
        }
        const targets = await ConfigManager.addTargets(valid);
        await msg.edit({ text: `✅ 目标已更新: ${targets.join(", ") || "无"}`, parseMode: "html" });
        return;
      }

      // 删除目标
      if (cmd === "del") {
        if (args.length < 2) {
          await msg.edit({ text: help_text, parseMode: "html" });
          return;
        }
        const target = args[1];
        const remaining = await ConfigManager.removeTarget(target);
        await msg.edit({
          text: target === "all" ? "✅ 已清空所有目标" : `✅ 已删除 ${target}\n当前目标: ${remaining.join(", ") || "无"}`,
          parseMode: "html",
        });
        return;
      }

      // 一次性目标
      let oneTimeTargets: string[] | null = null;
      if (cmd === "to") {
        if (args.length < 2) {
          await msg.edit({ text: help_text, parseMode: "html" });
          return;
        }
        const ids = args.slice(1).join(" ").replace(/,/g, " ").split(/\s+/).filter(Boolean).map((id) => (/^100\d+$/.test(id) ? `-${id}` : id));
        if (ids.length === 0) {
          await msg.edit({ text: "❌ 无效的聊天ID", parseMode: "html" });
          return;
        }
        oneTimeTargets = ids;
      }

      const client = await getGlobalClient();

      try {
        await msg.edit({ text: "🔄 正在创建备份...", parseMode: "html" });

        const programDir = process.cwd();
        const backupName = generateBackupName();
        const backupPath = path.join(os.tmpdir(), backupName);

        let backupType = "可移植备份";
        let contentDesc = "插件、配置、Session（换服务器可用）";
        let manifestInfo = "";
        let fileCount = 0;
        let totalRawSize = 0;

        if (cmd === "all") {
          const parentDir = path.dirname(programDir);
          const dirName = path.basename(programDir);
          await lifecycle.runTask(
            async () =>
              await new Promise<void>((resolve, reject) => {
                const tar = trackChildProcess(spawn("tar", [
                  "-cf", "-", "-C", parentDir,
                  "--exclude=node_modules", "--exclude=.git", "--exclude=my_session",
                  "--exclude=temp", "--exclude=logs", dirName,
                ], { stdio: ["pipe", "pipe", "pipe"] }), lifecycle, "bf:full-tar");
                const gzip = trackChildProcess(spawn("gzip", ["-1"], { stdio: ["pipe", "pipe", "pipe"] }), lifecycle, "bf:full-gzip");
                const output = fs.createWriteStream(backupPath);
                tar.stdout.pipe(gzip.stdin);
                gzip.stdout.pipe(output);
                let tarError = "", gzipError = "", settled = false;
                tar.stderr.on("data", (d) => (tarError += d.toString()));
                gzip.stderr.on("data", (d) => (gzipError += d.toString()));
                const finish = (cb: () => void) => { if (settled) return; settled = true; cb(); };
                output.on("finish", () => finish(() => resolve()));
                output.on("error", (err) => finish(() => reject(err)));
                tar.on("error", () => finish(() => reject(new Error(`tar error: ${tarError}`))));
                gzip.on("error", () => finish(() => reject(new Error(`gzip error: ${gzipError}`))));
                tar.on("close", (code) => { if (code !== 0) finish(() => reject(new Error(`tar exit ${code}: ${tarError}`))); });
                gzip.on("close", (code) => { if (code !== 0) finish(() => reject(new Error(`gzip exit ${code}: ${gzipError}`))); });
                throwIfAborted(lifecycle);
              }),
            { label: "bf:full-backup-pipeline" }
          );
          backupType = "全量备份";
          contentDesc = "程序目录（排除node_modules等）";
        } else if (cmd === "light") {
          const dirsToBackup = [
            path.join(programDir, "plugins"),
            path.join(programDir, "assets"),
          ].filter(fs.existsSync);
          if (dirsToBackup.length === 0) {
            await msg.edit({ text: "❌ 没有找到可备份的目录", parseMode: "html" });
            return;
          }
          await createBackup(dirsToBackup, backupPath, lifecycle, STANDARD_BACKUP_EXCLUDES);
          backupType = "轻量备份";
          contentDesc = "plugins, assets";
        } else {
          // 默认可移植备份
          const includeSession = cmd !== "nosession";
          const result = await createPortableBackup(programDir, backupPath, lifecycle, { includeSession });
          fileCount = result.fileCount;
          totalRawSize = result.totalRawSize;
          if (!includeSession) {
            backupType = "可移植备份（无Session）";
            contentDesc = "插件、配置（不含Telegram登录态）";
          }

          // 校验
          await msg.edit({ text: "🔍 正在校验备份...", parseMode: "html" });
          const verifyResult = await verifyBackup(backupPath, lifecycle);
          if (!verifyResult.valid) {
            throw new Error(`备份校验失败: ${verifyResult.error}`);
          }
          if (verifyResult.manifest) {
            manifestInfo = `\n📄 文件数: ${verifyResult.manifest.fileCount}\n🔐 SHA-256: ${verifyResult.manifest.sha256.slice(0, 16)}...`;
          }
        }

        await msg.edit({ text: "📤 正在上传备份...", parseMode: "html" });

        const stats = fs.statSync(backupPath);
        const caption =
          `📦 <b>TeleBox ${backupType}</b>\n\n` +
          `🕐 <b>时间</b>: ${formatCN(new Date())}\n` +
          `📊 <b>大小</b>: ${(stats.size / 1024 / 1024).toFixed(2)} MB\n` +
          `📋 <b>内容</b>: ${contentDesc}${manifestInfo}`;

        const savedTargets = await ConfigManager.getTargets();
        const destinations = oneTimeTargets && oneTimeTargets.length > 0
          ? oneTimeTargets
          : savedTargets.length > 0
          ? savedTargets
          : ["me"];
        const destDisplays: string[] = [];
        const failedTargets: string[] = [];
        let keepBackupPath: string | null = null;

        for (const dest of destinations) {
          const { display } = await formatEntity(dest);
          const destDisplay = describeDestination(dest, display);
          destDisplays.push(destDisplay);
          try {
            await safeEditMessage(msg, {
              text:
                `📤 正在上传备份...\n\n` +
                `🎯 目标: ${destDisplay}\n` +
                `📦 大小: ${(stats.size / 1024 / 1024).toFixed(2)} MB\n` +
                `📈 进度: 0%\n` +
                `🧩 阶段: 准备上传`,
              parseMode: "html",
            });
            await uploadBackupFile(client, msg, dest, destDisplay, backupPath, caption, stats.size);
          } catch (err) {
            console.error(`发送到 ${dest} 失败:`, err);
            failedTargets.push(`${destDisplay}: ${String(err)}`);
          }
        }

        if (failedTargets.length > 0) {
          const keepDir = path.join(programDir, "..", "telebox-backups");
          fs.mkdirSync(keepDir, { recursive: true });
          keepBackupPath = path.join(keepDir, path.basename(backupPath));
          fs.copyFileSync(backupPath, keepBackupPath);
          await msg.edit({
            text:
              `❌ <b>备份创建成功，但上传失败</b>\n\n` +
              `📦 <b>大小</b>: ${(stats.size / 1024 / 1024).toFixed(2)} MB\n` +
              `📍 <b>服务器文件</b>: <code>${keepBackupPath}</code>\n\n` +
              failedTargets.map((t) => `• ${t}`).join("\n"),
            parseMode: "html",
          });
          return;
        }

        await msg.edit({
          text:
            `✅ <b>${backupType}完成</b>\n\n` +
            `🎯 <b>发送到</b>: ${destDisplays.join(", ")}\n` +
            `📦 <b>内容</b>: ${contentDesc}\n` +
            `💾 <b>大小</b>: ${(stats.size / 1024 / 1024).toFixed(2)} MB${manifestInfo}`,
          parseMode: "html",
        });
      } catch (error) {
        await msg.edit({
          text: `❌ 备份失败: ${String(error)}`,
          parseMode: "html",
        });
      } finally {
        try {
          const tempFiles = fs.readdirSync(os.tmpdir()).filter(
            (f) => f.includes("telebox_backup") && f.endsWith(".tar.gz")
          );
          for (const f of tempFiles) {
            fs.unlinkSync(path.join(os.tmpdir(), f));
          }
        } catch (cleanupErr) {
          console.warn(`[bf] 临时备份文件清理失败: ${String(cleanupErr)}`);
        }
      }
    },

    hf: async (msg: Api.Message) => {
      const lifecycle = this.getLifecycle();
      const args = msg.message.slice(1).split(" ").slice(1);
      const cmd = args[0] || "";

      if (cmd === "help" || cmd === "帮助") {
        await msg.edit({
          text:
            "🔄 <b>TeleBox 恢复系统</b>\n\n" +
            "📁 回复备份文件消息，发送 <code>hf</code> 恢复\n" +
            "📦 支持格式: .tar.gz 备份文件\n" +
            "🔐 自动校验完整性\n" +
            "🔄 恢复后会自动重载插件\n" +
            "⚠️ 建议恢复后备份当前状态，以便回滚",
          parseMode: "html",
        });
        return;
      }

      if (!msg.replyTo) {
        await msg.edit({
          text: "❌ 请回复一个备份文件消息后使用 <code>hf</code>",
          parseMode: "html",
        });
        return;
      }

      const client = await getGlobalClient();

      try {
        const messages = await safeGetMessages(client, msg.peerId, {
          ids: [msg.replyTo.replyToMsgId!],
        });

        const backupMsg = messages[0];
        if (!backupMsg?.file?.name?.endsWith(".tar.gz")) {
          await msg.edit({ text: "❌ 回复的消息不是有效的备份文件", parseMode: "html" });
          return;
        }

        await msg.edit({ text: "📥 正在下载备份...", parseMode: "html" });

        const tempPath = path.join(os.tmpdir(), `restore_${Date.now()}.tar.gz`);
        const buffer = await client.downloadMedia(backupMsg);
        if (!buffer) throw new Error("下载失败");
        fs.writeFileSync(tempPath, buffer);

        await msg.edit({ text: "🔍 正在校验备份完整性...", parseMode: "html" });

        const verifyResult = await verifyBackup(tempPath, lifecycle);
        if (!verifyResult.valid) {
          fs.unlinkSync(tempPath);
          throw new Error(`备份校验失败: ${verifyResult.error}`);
        }

        let manifestInfo = "";
        if (verifyResult.manifest) {
          manifestInfo = `\n📄 文件数: ${verifyResult.manifest.fileCount}\n🔐 清单校验通过`;
        }

        await msg.edit({ text: `📦 正在解压备份...${manifestInfo}`, parseMode: "html" });

        const extractPath = path.join(os.tmpdir(), `extract_${Date.now()}`);
        fs.mkdirSync(extractPath, { recursive: true });
        const backupRoot = await safeExtract(tempPath, extractPath, lifecycle);

        await msg.edit({ text: "🔄 正在恢复备份...", parseMode: "html" });

        const programDir = process.cwd();
        let restoreResult: { needsRestart: boolean; rollbackDir: string };

        if (verifyResult.manifest) {
          restoreResult = await restorePortableBackup(backupRoot, programDir, lifecycle);
        } else {
          await restoreBackup(extractPath);
          restoreResult = { needsRestart: true, rollbackDir: path.join(programDir, `_restore_backup_${Date.now()}`) };
        }

        // 清理临时文件
        try {
          fs.unlinkSync(tempPath);
          fs.rmSync(extractPath, { recursive: true, force: true });
        } catch (cleanupErr) {
          console.warn(`[bf] 恢复后清理: ${String(cleanupErr)}`);
        }

        // 尝试重载或重启
        try {
          const pluginManager = require("@utils/pluginManager");
          if (pluginManager.loadPlugins && !restoreResult.needsRestart) {
            await msg.edit({
              text: `✅ 恢复完成并已重载插件\n\n📂 原文件备份: <code>${restoreResult.rollbackDir}</code>`,
              parseMode: "html",
            });
            await pluginManager.loadPlugins();
          } else {
            await msg.edit({
              text:
                `✅ 恢复完成\n\n` +
                `📂 原文件备份: <code>${restoreResult.rollbackDir}</code>\n` +
                `🔄 包含 config.json / Session，建议重启程序使更改生效`,
              parseMode: "html",
            });
          }
        } catch (reloadErr) {
          console.error("Failed to reload after restore:", reloadErr);
          await msg.edit({
            text:
              `✅ 恢复完成\n\n` +
              `📂 原文件备份: <code>${restoreResult.rollbackDir}</code>\n` +
              `🔄 建议重启程序`,
            parseMode: "html",
          });
        }
      } catch (error) {
        await msg.edit({
          text: `❌ 恢复失败: ${String(error)}`,
          parseMode: "html",
        });
      }
    },
  };
}

export default new BfPlugin();

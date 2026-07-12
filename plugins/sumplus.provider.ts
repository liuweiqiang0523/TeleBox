import axios from "axios";
import { spawn } from "child_process";

const MAX_SUMMARY_INPUT_CHARS = 28000;

export type ProviderType = "openai" | "gemini";

export type ProviderConfig = {
  name?: string;
  type?: ProviderType;
  baseUrl: string;
  apiKey: string;
  model: string;
  stream?: boolean;
};

export type SumConfig = ProviderConfig & {
  type: ProviderType;
  prompt: string;
  maxOutputLength: number;
  replyMode: boolean;
  fallbacks?: ProviderConfig[];
};

export type ProviderUseInfo = {
  name: string;
  type: ProviderType;
  baseUrl: string;
  model: string;
};

export type TokenUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export type SummaryResult = {
  content: string;
  provider: ProviderUseInfo;
  usage?: TokenUsage;
};

export function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function openAIChatCompletionsUrl(baseUrl: string): string {
  const base = trimTrailingSlash(baseUrl);
  // Accept both provider roots (https://host) and OpenAI-compatible roots (https://host/v1).
  // Before this guard, a configured /v1 endpoint became /v1/v1/chat/completions.
  return base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
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

    child.stdout.on("data", (chunk: unknown) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: unknown) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code: number | null) => {
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

type ModelCallResult = {
  content: string;
  usage?: TokenUsage;
};

const FALLBACK_FORMAT_GUARD = `

【供应商通用格式守卫】
你可能是备用线路，但输出格式必须与主线路完全一致。
必须逐字保留上方模板规定的一级、二级栏目标题及顺序。
禁止自创标题、重复标题、解释性前言、Markdown 星号列表或整段加粗。
只生成模板正文，不要说明你遵守了哪些规则。`;

function requiredTemplateHeadings(prompt: string): string[] {
  const markerIndex = Math.max(
    prompt.lastIndexOf("【固定输出模板】"),
    prompt.lastIndexOf("【输出模板】"),
  );
  const template = markerIndex >= 0 ? prompt.slice(markerIndex) : prompt;
  return Array.from(template.matchAll(/^##\s+[^\n]+$/gm), (match) => match[0].trim());
}

function templateDriftReasons(content: string, prompt: string): string[] {
  const reasons: string[] = [];
  const trimmed = content.trim();
  if (!/^#\s+\S/m.test(trimmed) || !trimmed.startsWith("# ")) reasons.push("一级标题不符合模板");
  for (const heading of requiredTemplateHeadings(prompt)) {
    if (!trimmed.includes(heading)) reasons.push(`缺少栏目 ${heading.replace(/^##\s+/, "")}`);
  }
  if (/^\s*\*\s+/m.test(trimmed)) reasons.push("使用了星号列表");
  if (prompt.includes("禁止使用 **Markdown 加粗**") && trimmed.includes("**")) reasons.push("使用了禁用的加粗");
  if (trimmed.includes("```")) reasons.push("使用了代码块");
  return reasons;
}

function addTokenUsage(first?: TokenUsage, second?: TokenUsage): TokenUsage | undefined {
  if (!first) return second;
  if (!second) return first;
  const add = (a?: number, b?: number) => a === undefined && b === undefined ? undefined : (a || 0) + (b || 0);
  return {
    promptTokens: add(first.promptTokens, second.promptTokens),
    completionTokens: add(first.completionTokens, second.completionTokens),
    totalTokens: add(first.totalTokens, second.totalTokens),
  };
}

function numberFromUsage(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : undefined;
}

function normalizeOpenAIUsage(usage: any): TokenUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const promptTokens = numberFromUsage(usage.prompt_tokens ?? usage.promptTokens ?? usage.input_tokens ?? usage.inputTokens);
  const completionTokens = numberFromUsage(
    usage.completion_tokens ?? usage.completionTokens ?? usage.output_tokens ?? usage.outputTokens,
  );
  const totalTokens = numberFromUsage(usage.total_tokens ?? usage.totalTokens);
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) return undefined;
  return { promptTokens, completionTokens, totalTokens };
}

function normalizeGeminiUsage(usage: any): TokenUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const promptTokens = numberFromUsage(usage.promptTokenCount);
  const completionTokens = numberFromUsage(usage.candidatesTokenCount);
  const totalTokens = numberFromUsage(usage.totalTokenCount);
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) return undefined;
  return { promptTokens, completionTokens, totalTokens };
}

async function callOpenAI(config: SumConfig, messages: string): Promise<ModelCallResult> {
  const isGpt5Family = /^gpt-5(?:\.|-|$)/i.test(config.model.trim());
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
      ...(isGpt5Family ? { reasoning_effort: "none", verbosity: "low" } : {}),
      stream: Boolean(config.stream),
    },
  );

  const content = data?.choices?.[0]?.message?.content;
  if (!content || typeof content !== "string") {
    throw new Error("OpenAI 兼容接口返回空结果");
  }
  return {
    content: content.trim(),
    usage: normalizeOpenAIUsage(data?.usage),
  };
}

async function callGemini(config: SumConfig, messages: string): Promise<ModelCallResult> {
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
  return {
    content: content.trim(),
    usage: normalizeGeminiUsage(response.data?.usageMetadata),
  };
}

export async function summarize(config: SumConfig, messages: string): Promise<SummaryResult> {
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
    throw new Error("请先配置 API Key：.sum key YOUR_API_KEY");
  }

  for (const [providerIndex, provider] of providers.entries()) {
    if (!provider.apiKey) continue;

    const startedAt = Date.now();
    try {
      const providerConfig = {
        ...config,
        ...provider,
        type: provider.type || config.type,
        prompt: providerIndex === 0 ? config.prompt : `${config.prompt}${FALLBACK_FORMAT_GUARD}`,
      } as SumConfig;
      let result =
        providerConfig.type === "gemini"
          ? await callGemini(providerConfig, messages)
          : await callOpenAI(providerConfig, messages);
      let content = stripThinking(result.content);
      const driftReasons = templateDriftReasons(content, config.prompt);
      if (driftReasons.length > 0) {
        console.warn(
          `[sumplus] provider=${provider.name || provider.baseUrl} template drift; retrying: ${driftReasons.join(" / ")}`,
        );
        const repairConfig = {
          ...providerConfig,
          prompt: `${config.prompt}${FALLBACK_FORMAT_GUARD}\n这是格式修复任务：只重排已有内容，不新增、删除或改写事实。`,
        };
        const repairInput = [
          "请把下面这份摘要严格重排为系统提示中的固定模板。",
          "不得重新分析聊天，不得增加原文没有的信息。",
          "",
          "待重排摘要：",
          content,
        ].join("\n");
        const repaired = providerConfig.type === "gemini"
          ? await callGemini(repairConfig, repairInput)
          : await callOpenAI(repairConfig, repairInput);
        result = { ...repaired, usage: addTokenUsage(result.usage, repaired.usage) };
        content = stripThinking(repaired.content);
        const remainingReasons = templateDriftReasons(content, config.prompt);
        if (remainingReasons.length > 0) {
          throw new Error(`模板格式不合格：${remainingReasons.join(" / ")}`);
        }
      }
      console.info(
        `[sumplus] provider=${provider.name || provider.baseUrl} model=${provider.model} durationMs=${Date.now() - startedAt}`,
      );

      return {
        content,
        provider: {
          name: provider.name || provider.baseUrl,
          type: providerConfig.type,
          baseUrl: provider.baseUrl,
          model: provider.model,
        },
        usage: result.usage,
      };
    } catch (error: any) {
      const name = provider.name || provider.baseUrl;
      const message = error?.response?.data?.error?.message || error?.message || String(error);
      console.warn(`[sumplus] provider=${name} model=${provider.model} failed durationMs=${Date.now() - startedAt}: ${message}`);
      errors.push(`${name}: ${message}`);
    }
  }

  throw new Error(`所有接口都失败：${errors.join("；")}`);
}

export function formatTokenNumber(value: number | undefined): string {
  return value === undefined ? "-" : value.toLocaleString("en-US");
}

export function tokenUsageText(usage?: TokenUsage): string {
  if (!usage) return "";
  const totalTokens = usage.totalTokens ?? (
    usage.promptTokens !== undefined && usage.completionTokens !== undefined
      ? usage.promptTokens + usage.completionTokens
      : undefined
  );
  if (usage.promptTokens === undefined && usage.completionTokens === undefined && totalTokens === undefined) return "";
  return `Token：输入 ${formatTokenNumber(usage.promptTokens)} / 输出 ${formatTokenNumber(usage.completionTokens)} / 总计 ${formatTokenNumber(totalTokens)}`;
}

export function providerChainLines(config: SumConfig): string[] {
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

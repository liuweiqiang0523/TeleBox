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

      const content = stripThinking(result.content);
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

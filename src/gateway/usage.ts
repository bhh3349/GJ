/**
 * 网关内核 - token 计数
 * 冻结依据：docs/api-contract.md §0.2（token 永远是 int）/ ADR 记「usage 缺失按字符估算并标 is_estimated=1 且计入配额」
 *
 * 两件事必须分清：
 *   1. 上游给了 usage → 原样采信（取自上游，最准）
 *   2. 上游没给 / 流式未带 usage → 按字符估算，isEstimated=true，**照样计入 TPM 与日配额**
 * 估算口径：约 4 字符 = 1 token（英文），中日文按 1 字符 ≈ 1 token 更接近真实，
 * 这里取「非 ASCII 字符合计权重 1、其余 0.25」的折中，只在缺 usage 时使用。
 */

import type { TokenUsage } from './types.js';

/** 估算：ASCII 0.25 token/字符，非 ASCII 1 token/字符；向上取整、最小 0 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let wide = 0;
  for (const ch of text) {
    if (ch.codePointAt(0)! > 0x7f) wide += 1;
    else ascii += 1;
  }
  return Math.ceil(ascii / 4) + wide;
}

function textOfPart(part: unknown): string {
  if (typeof part === 'string') return part;
  if (typeof part !== 'object' || part === null) return '';
  const type = (part as { type?: unknown }).type;
  if (type === 'text') {
    const text = (part as { text?: unknown }).text;
    return typeof text === 'string' ? text : '';
  }
  // image_url 等多模态分片按固定开销估，不解析 base64（那是天文数字）
  return '[multimodal]';
}

/** 估算 prompt 侧 token：messages[].content 支持 string 与分片数组 */
export function estimatePromptTokens(body: unknown): number {
  if (typeof body !== 'object' || body === null) return 0;
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) {
    const input = (body as { input?: unknown }).input;
    if (typeof input === 'string') return estimateTokens(input);
    if (Array.isArray(input)) return input.reduce<number>((sum, item) => sum + estimateTokens(textOfPart(item)), 0);
    return 0;
  }
  let total = 0;
  for (const msg of messages) {
    if (typeof msg !== 'object' || msg === null) continue;
    const content = (msg as { content?: unknown }).content;
    if (typeof content === 'string') total += estimateTokens(content);
    else if (Array.isArray(content)) {
      for (const part of content) total += estimateTokens(textOfPart(part));
    }
    const role = (msg as { role?: unknown }).role;
    if (typeof role === 'string') total += 1; // 每条消息的角色开销
    const name = (msg as { name?: unknown }).name;
    if (typeof name === 'string') total += estimateTokens(name);
  }
  return total;
}

function readInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  return null;
}

/** 从上游响应体读 usage；缺字段按可读到的部分补齐，全缺返回 null */
export function extractUsage(payload: unknown): TokenUsage | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const usage = (payload as { usage?: unknown }).usage;
  if (typeof usage !== 'object' || usage === null) return null;

  const prompt = readInt((usage as { prompt_tokens?: unknown }).prompt_tokens);
  const completion = readInt((usage as { completion_tokens?: unknown }).completion_tokens);
  const total = readInt((usage as { total_tokens?: unknown }).total_tokens);
  if (prompt === null && completion === null && total === null) return null;

  const p = prompt ?? 0;
  const c = completion ?? 0;
  return { prompt: p, completion: c, total: total ?? p + c, isEstimated: false };
}

/** 用估算补齐缺失的 completion 侧 token */
export function estimateCompletionTokens(payload: unknown): number {
  if (typeof payload !== 'object' || payload === null) return 0;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return 0;
  let total = 0;
  for (const choice of choices) {
    if (typeof choice !== 'object' || choice === null) continue;
    const message = (choice as { message?: unknown }).message;
    if (typeof message !== 'object' || message === null) continue;
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') total += estimateTokens(content);
  }
  return total;
}

/**
 * 非流式收尾：上游有 usage 就用，没有就估算并标 isEstimated。
 * 两者都拿不到（空体）→ 返回总 0 的估算值，仍然记账（宁可少记，不可不记）。
 */
export function resolveUsage(requestBody: unknown, responsePayload: unknown): TokenUsage {
  const fromUpstream = extractUsage(responsePayload);
  if (fromUpstream !== null) return fromUpstream;

  const prompt = estimatePromptTokens(requestBody);
  const completion = estimateCompletionTokens(responsePayload);
  return { prompt, completion, total: prompt + completion, isEstimated: true };
}

/**
 * 流式 usage 累积器。
 * - 上游 `stream_options.include_usage=true` 时最后一个 chunk 带 usage → 采信
 * - 否则拼 delta.content 估算 completion，prompt 从请求体估算
 * - 中途 `data: [DONE]` 不终止累积（上游可能之后才补 usage，实际按顺序结束即可）
 */
export interface StreamUsageTracker {
  /** 喂一段原始 SSE 文本（可跨 chunk 切断，内部保留残行） */
  push(chunk: string): void;
  /** 流正常结束：给出最终 usage */
  finish(requestBody: unknown): TokenUsage;
}

export function createStreamUsageTracker(): StreamUsageTracker {
  let buffer = '';
  let upstreamUsage: TokenUsage | null = null;
  let completionText = '';

  return {
    push(chunk: string): void {
      buffer += chunk;
      let idx = buffer.indexOf('\n');
      while (idx !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        consumeLine(line);
        idx = buffer.indexOf('\n');
      }
    },
    finish(requestBody: unknown): TokenUsage {
      if (buffer !== '') {
        consumeLine(buffer);
        buffer = '';
      }
      if (upstreamUsage !== null) return upstreamUsage;
      const prompt = estimatePromptTokens(requestBody);
      const completion = estimateTokens(completionText);
      return { prompt, completion, total: prompt + completion, isEstimated: true };
    },
  };

  function consumeLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (data === '' || data === '[DONE]') return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return; // 上游偶发半行/心跳，不视为错误
    }

    const usage = extractUsage(parsed);
    if (usage !== null) {
      upstreamUsage = usage;
      return;
    }

    if (typeof parsed !== 'object' || parsed === null) return;
    const choices = (parsed as { choices?: unknown }).choices;
    if (!Array.isArray(choices)) return;
    for (const choice of choices) {
      if (typeof choice !== 'object' || choice === null) continue;
      const delta = (choice as { delta?: unknown }).delta;
      if (typeof delta !== 'object' || delta === null) continue;
      const content = (delta as { content?: unknown }).content;
      if (typeof content === 'string') completionText += content;
      const reasoning = (delta as { reasoning_content?: unknown }).reasoning_content;
      if (typeof reasoning === 'string') completionText += reasoning;
    }
  }
}

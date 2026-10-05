/**
 * token 计数单测
 * 依据：契约 §0.2（token 恒为 int）+「缺 usage 按估算并标 isEstimated」
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { createStreamUsageTracker, estimatePromptTokens, estimateTokens, extractUsage, resolveUsage } from './usage.js';

describe('estimateTokens', () => {
  it('纯 ASCII 约 4 字符 1 token；非 ASCII 约 1 字符 1 token', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens('abcd'), 1);
    assert.equal(estimateTokens('abcde'), 2);
    assert.equal(estimateTokens('你好'), 2);
    assert.equal(estimateTokens('你好ab'), 3);
  });

  it('恒为非负整数', () => {
    for (const text of ['', 'a', '🙂🙂', '中文 mixed 内容', '\n\n\n\n\n']) {
      const n = estimateTokens(text);
      assert.ok(Number.isInteger(n), `${text} → ${n} 必须是整数`);
      assert.ok(n >= 0, `${text} → ${n} 不得为负`);
    }
  });
});

describe('estimatePromptTokens', () => {
  it('字符串 content 与分片数组 content 都算', () => {
    const flat = estimatePromptTokens({ messages: [{ role: 'user', content: 'hello world' }] });
    assert.ok(flat > 0);

    const parts = estimatePromptTokens({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello world' }, { type: 'image_url', image_url: { url: 'data:...' } }] }],
    });
    assert.ok(parts > flat, '多模态分片要按固定开销计入');
  });

  it('embeddings 的 input 也认（string 与数组两种形态）', () => {
    assert.ok(estimatePromptTokens({ input: 'some text to embed' }) > 0);
    assert.ok(estimatePromptTokens({ input: ['a', 'bb'] }) > 0);
  });

  it('认不出的形态返回 0，不抛异常', () => {
    assert.equal(estimatePromptTokens(null), 0);
    assert.equal(estimatePromptTokens({}), 0);
    assert.equal(estimatePromptTokens({ messages: 'not-an-array' }), 0);
  });
});

describe('extractUsage', () => {
  it('上游给了 usage → 原样采信，isEstimated=false', () => {
    assert.deepEqual(extractUsage({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }), {
      prompt: 10,
      completion: 5,
      total: 15,
      isEstimated: false,
    });
  });

  it('缺 total_tokens 用 prompt+completion 补；字段缺失按 0，不出现小数', () => {
    assert.deepEqual(extractUsage({ usage: { prompt_tokens: 7 } }), { prompt: 7, completion: 0, total: 7, isEstimated: false });
    assert.deepEqual(extractUsage({ usage: { prompt_tokens: 12.9 } })?.prompt, 12);
  });

  it('完全没有 usage / 空对象 → null', () => {
    assert.equal(extractUsage({ choices: [] }), null);
    assert.equal(extractUsage({ usage: {} }), null);
    assert.equal(extractUsage(null), null);
  });
});

describe('resolveUsage', () => {
  it('上游有 usage 时不用估算', () => {
    const usage = resolveUsage({ messages: [{ role: 'user', content: 'hi' }] }, { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    assert.equal(usage.isEstimated, false);
    assert.equal(usage.total, 2);
  });

  it('上游无 usage 时估算并标记 isEstimated（仍要计入配额）', () => {
    const usage = resolveUsage(
      { messages: [{ role: 'user', content: 'hello world' }] },
      { choices: [{ message: { role: 'assistant', content: 'hi there' } }] },
    );
    assert.equal(usage.isEstimated, true);
    assert.ok(usage.prompt > 0);
    assert.ok(usage.completion > 0);
    assert.equal(usage.total, usage.prompt + usage.completion);
  });

  it('空响应体 → 全 0 的估算值，仍然是合法对象（宁可少记不可不记）', () => {
    const usage = resolveUsage({ messages: [] }, null);
    assert.deepEqual(usage, { prompt: 0, completion: 0, total: 0, isEstimated: true });
  });
});

describe('createStreamUsageTracker', () => {
  it('上游末帧带 usage 时采信上游', () => {
    const tracker = createStreamUsageTracker();
    tracker.push('data: {"choices":[{"delta":{"content":"你"}}]}\n\n');
    tracker.push('data: {"choices":[{"delta":{"content":"好"}}],"usage":{"prompt_tokens":9,"completion_tokens":2,"total_tokens":11}}\n\n');
    tracker.push('data: [DONE]\n\n');

    const usage = tracker.finish({ messages: [{ role: 'user', content: 'x' }] });
    assert.equal(usage.isEstimated, false);
    assert.equal(usage.total, 11);
  });

  it('无 usage 时拼 delta.content 估算；跨 chunk 切断的行也能拼回', () => {
    const tracker = createStreamUsageTracker();
    // 故意把一行 SSE 切成三块，模拟 TCP 分片
    tracker.push('data: {"choices":[{"delta":{"cont');
    tracker.push('ent":"hello"}}]}\n');
    tracker.push('\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\n');
    tracker.push('data: [DONE]\n\n');

    const usage = tracker.finish({ messages: [{ role: 'user', content: 'hello world' }] });
    assert.equal(usage.isEstimated, true);
    assert.ok(usage.completion >= 2, `completion 应含 hello world，实际 ${usage.completion}`);
    assert.equal(usage.total, usage.prompt + usage.completion);
  });

  it('心跳、非 data 行、坏 JSON 都不算错、不中断', () => {
    const tracker = createStreamUsageTracker();
    tracker.push(': keep-alive\n\n');
    tracker.push('event: ping\n\n');
    tracker.push('data: {broken\n\n');
    tracker.push('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');

    const usage = tracker.finish({ messages: [] });
    assert.ok(usage.completion > 0);
  });
});

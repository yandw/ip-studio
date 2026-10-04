import { reserveQuota } from './quota.js';
/* 大模型接入层
 *   anthropic —— 官方 SDK（默认 claude-opus-5），结构化输出 + 流式正文
 *   openai    —— 任意 OpenAI 兼容接口（DeepSeek / Kimi / 通义 / vLLM / Ollama）
 *   mock      —— 无密钥时的本地模板，保证系统开箱可跑通全流程
 */
import Anthropic from '@anthropic-ai/sdk';

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'deepseek-chat';
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/$/, '');
const OPENAI_KEY = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || '';

/* 采样参数：1.3 实测在中文长文里会跑出语无伦次的句子，降到 1.0（DeepSeek 的默认值）稳很多。
 * 语气由账号设定和语气档案负责，不靠高温度堆"创意"。可用环境变量微调。 */
const TEMP_PROSE = Number(process.env.LLM_TEMPERATURE) || 1.0;
const TEMP_JSON = Number(process.env.LLM_TEMPERATURE_JSON) || 0.6;
const TOP_P = Number(process.env.LLM_TOP_P) || 0.95;

function detectProvider() {
  const forced = (process.env.LLM_PROVIDER || '').toLowerCase();
  if (forced) return forced;
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return 'anthropic';
  if (OPENAI_KEY) return 'openai';
  return 'mock';
}

export const PROVIDER = detectProvider();

export function providerInfo() {
  const model = PROVIDER === 'anthropic' ? ANTHROPIC_MODEL : PROVIDER === 'openai' ? OPENAI_MODEL : '本地模板';
  const label = { anthropic: 'Claude', openai: 'OpenAI 兼容接口', mock: '演示模式（未配置密钥）' }[PROVIDER] || PROVIDER;
  return { provider: PROVIDER, model, label, live: PROVIDER !== 'mock' };
}

let _anthropic;
const anthropic = () => (_anthropic ||= new Anthropic());

/* ------------------------------------------------------------------ *
 * 用量埋点：由 index.js 注入落库函数，这一层不直接依赖 db
 * ------------------------------------------------------------------ */
let usageSink = null;
export const setUsageSink = (fn) => { usageSink = fn; };

/* 配额在这里统一拦，不在十几个调用点各写一遍——那样一定会漏一个。
   eval 跑批不占用户额度（它是后台行为，成本记在管理员头上）。 */
async function tracked(meta, run) {
  const started = Date.now();
  const model = PROVIDER === 'anthropic' ? ANTHROPIC_MODEL : PROVIDER === 'openai' ? OPENAI_MODEL : 'mock';
  const metered = meta.userId && !String(meta.feature || '').startsWith('eval');
  const reservation = metered ? reserveQuota(meta.userId, '文案') : null;
  try {
    const { value, usage } = await run();
    const tokens = (usage?.input || 0) + (usage?.output || 0);
    usageSink?.({
      ...meta, provider: PROVIDER, model, ok: true, ms: Date.now() - started,
      inputTokens: usage?.input || 0, outputTokens: usage?.output || 0,
      units: tokens, unit: 'token',
    });
    reservation?.settle(tokens);
    return value;
  } catch (err) {
    reservation?.release();
    usageSink?.({
      ...meta, provider: PROVIDER, model, ok: false, ms: Date.now() - started,
      error: String(err?.message || err),
    });
    throw err;
  }
}

/* ------------------------------------------------------------------ *
 * 结构化生成：返回符合 schema 的对象
 * ------------------------------------------------------------------ */
export async function generateJSON({ system, user, schema, mock, meta = {} }) {
  return tracked({ feature: 'unknown', ...meta }, async () => {
    if (PROVIDER === 'mock') return { value: mock(), usage: null };

    if (PROVIDER === 'anthropic') {
      const res = await anthropic().messages.create({
        model: ANTHROPIC_MODEL,
        max_tokens: 16000,
        system,
        messages: [{ role: 'user', content: user }],
        output_config: { format: { type: 'json_schema', schema }, effort: 'medium' },
      });
      const text = res.content.find((b) => b.type === 'text')?.text || '';
      return {
        value: parseJSON(text),
        usage: { input: res.usage?.input_tokens, output: res.usage?.output_tokens },
      };
    }

    const res = await openaiChat({
      system,
      user: `${user}\n\n只输出一个 JSON 对象，不要任何解释或代码块标记。JSON Schema：\n${JSON.stringify(schema)}`,
      stream: false,
      temperature: TEMP_JSON,    // 结构化输出用低温度，减少格式跑偏
      responseFormat: { type: 'json_object' },
    });
    return { value: parseJSON(res.text), usage: res.usage };
  });
}

/* ------------------------------------------------------------------ *
 * 一次性文本生成（不流式）：用于语气档案这类短输出
 * ------------------------------------------------------------------ */
export async function generateText({ system, user, mock, meta = {} }) {
  return tracked({ feature: 'unknown', ...meta }, async () => {
    if (PROVIDER === 'mock') return { value: mock(), usage: null };

    if (PROVIDER === 'anthropic') {
      const res = await anthropic().messages.create({
        model: ANTHROPIC_MODEL,
        max_tokens: 4000,
        system,
        messages: [{ role: 'user', content: user }],
        output_config: { effort: 'medium' },
      });
      return {
        value: res.content.filter((b) => b.type === 'text').map((b) => b.text).join(''),
        usage: { input: res.usage?.input_tokens, output: res.usage?.output_tokens },
      };
    }

    const res = await openaiChat({ system, user, stream: false });
    return { value: res.text, usage: res.usage };
  });
}

/* ------------------------------------------------------------------ *
 * 流式正文：逐段回调 onDelta，返回完整文本
 * ------------------------------------------------------------------ */
export async function streamText({ system, user, onDelta, mock, signal, meta = {} }) {
  return tracked({ feature: 'unknown', ...meta }, () => streamOnce({ system, user, onDelta, mock, signal }));
}

async function streamOnce({ system, user, onDelta, mock, signal }) {
  if (PROVIDER === 'mock') return { value: await streamMock(mock(), onDelta, signal), usage: null };

  if (PROVIDER === 'anthropic') {
    const stream = anthropic().messages.stream(
      {
        model: ANTHROPIC_MODEL,
        max_tokens: 16000,
        system,
        messages: [{ role: 'user', content: user }],
        output_config: { effort: 'medium' },
      },
      { signal },
    );
    let full = '';
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        full += event.delta.text;
        onDelta(event.delta.text);
      }
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') {
      throw new Error(`模型拒绝了该请求（${final.stop_details?.category || '未说明原因'}）`);
    }
    return {
      value: full,
      usage: { input: final.usage?.input_tokens, output: final.usage?.output_tokens },
    };
  }

  const res = await openaiChat({ system, user, stream: true, onDelta, signal });
  return { value: res.text, usage: res.usage };
}

/* ------------------------------------------------------------------ *
 * OpenAI 兼容协议
 * ------------------------------------------------------------------ */
async function openaiChat({ system, user, stream, onDelta, responseFormat, signal, temperature = TEMP_PROSE }) {
  const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      ...(OPENAI_KEY ? { Authorization: `Bearer ${OPENAI_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      stream: Boolean(stream),
      temperature,
      top_p: TOP_P,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...(responseFormat ? { response_format: responseFormat } : {}),
    }),
  });

  if (!res.ok) {
    throw new Error(`上游接口返回 ${res.status}：${(await res.text()).slice(0, 300)}`);
  }

  if (!stream) {
    const data = await res.json();
    return {
      text: data.choices?.[0]?.message?.content || '',
      usage: { input: data.usage?.prompt_tokens, output: data.usage?.completion_tokens },
    };
  }

  let full = '';
  let buf = '';
  let usage = null;
  let done = false;
  let finished = false;
  const decoder = new TextDecoder();
  const readLine = (line) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload) return;
    if (payload === '[DONE]') { done = true; return; }
    let chunk;
    try { chunk = JSON.parse(payload); }
    catch { throw new Error('上游流式接口返回了无法解析的数据'); }
    if (chunk.error) throw new Error(`上游流式接口返回错误：${String(chunk.error.message || chunk.error).slice(0, 200)}`);
    const choice = chunk.choices?.[0];
    if (choice?.finish_reason) {
      if (choice.finish_reason !== 'stop') throw new Error(`上游生成未完成（${choice.finish_reason}）`);
      finished = true;
    }
    const delta = choice?.delta?.content;
    if (delta) { full += delta; onDelta?.(delta); }
    if (chunk.usage) usage = { input: chunk.usage.prompt_tokens, output: chunk.usage.completion_tokens };
  };
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) readLine(line);
  }
  // 兼容没有末尾换行的最后一个事件，并刷新 TextDecoder 的尾部缓冲。
  readLine(buf + decoder.decode());
  if (!done && !finished) throw new Error('上游流式输出中断，请重试');
  if (!full.trim()) throw new Error('上游没有返回正文');
  return { text: full, usage };
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */
export function parseJSON(text) {
  const cleaned = String(text).replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(cleaned); } catch { /* 继续尝试截取 */ }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { /* fallthrough */ }
  }
  throw new Error('模型没有返回可解析的 JSON');
}

async function streamMock(text, onDelta, signal) {
  for (let i = 0; i < text.length; i += 12) {
    signal?.throwIfAborted();
    onDelta(text.slice(i, i + 12));
    await new Promise((r) => setTimeout(r, 18));
  }
  signal?.throwIfAborted();
  return text;
}

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createCipheriv, createSign, createVerify, generateKeyPairSync } from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(), 'ip-studio-test-'));
process.env.DB_PATH = join(dir, 'app.db');
process.env.LLM_PROVIDER = 'openai';
process.env.OPENAI_API_KEY = 'test-key';
process.env.IMAGE_PROVIDER = 'openai';
process.env.IMAGE_API_KEY = 'test-key';
const { db, Users, Sessions, Drafts, Quota } = await import('../server/db.js');
const { generateText, streamText } = await import('../server/llm.js');
const { snapshot, reserveQuota } = await import('../server/quota.js');
const { handleContent, handleIllusImage } = await import('../server/routes.js');
const { createPayment, verifyNotify } = await import('../server/pay.js');
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; db.close(); rmSync(dir, { recursive: true, force: true }); });

let nextUser = 0;
function account(used = 0, plan = 'free') {
  const user = Users.create(`user-${++nextUser}`, 'unused');
  Quota.setPlan(user.id, plan);
  snapshot(user.id);
  db.prepare('UPDATE users SET used = ? WHERE id = ?').run(used, user.id);
  const token = `session-${user.id}`;
  Sessions.create(token, user.id, 60000);
  const req = new EventEmitter();
  req.headers = { cookie: `cw_session=${token}` };
  return { user, req };
}
function response() {
  const res = new EventEmitter();
  res.chunks = [];
  res.writeHead = (status) => { res.status = status; };
  res.write = (s) => { res.chunks.push(s); };
  res.end = (s = '') => { res.chunks.push(s); };
  return res;
}
function article(user) {
  const draft = Drafts.create(user.id, {
    subject: '复盘习惯', platform: 'wechat', tone: 'professional', audience: '', keywords: '', length: 800,
  });
  Drafts.setTopics(draft.id, user.id, [{ title: '已有文章', outline: ['方法'] }], null);
  Drafts.setContent(draft.id, user.id, { chosen: 0, title: '已有文章', content: '已编辑保存的正文', status: 'done' });
  return draft;
}
const completion = () => Response.json({
  choices: [{ message: { content: 'generated' } }],
  usage: { prompt_tokens: 6000, completion_tokens: 6000 },
});
const sse = (text) => new Response(text, { headers: { 'Content-Type': 'text/event-stream' } });

test('并发文本请求只能使用一次剩余配额', async () => {
  const { user } = account(145);
  const waiting = [];
  globalThis.fetch = () => new Promise((resolve) => { waiting.push(resolve); });
  const results = Promise.allSettled(Array.from({ length: 20 }, () =>
    generateText({ system: 'test', user: 'test', meta: { userId: user.id, feature: '成稿' } })));
  waiting.forEach((resolve) => resolve(completion()));
  const settled = await results;
  assert.equal(waiting.length, 1);
  assert.equal(settled.filter((r) => r.status === 'fulfilled').length, 1);
  assert(settled.filter((r) => r.status === 'rejected').every((r) => r.reason.status === 402));
  assert.equal(snapshot(user.id).used, 150);
});

test('模型失败释放预留额度，后续请求仍可成功', async () => {
  const { user } = account(145);
  globalThis.fetch = async () => new Response('failure', { status: 500 });
  const input = { system: 'test', user: 'test', meta: { userId: user.id, feature: '成稿' } };
  await assert.rejects(generateText(input));
  assert.equal(snapshot(user.id).left, 5);
  globalThis.fetch = async () => completion();
  await generateText(input);
  assert.equal(snapshot(user.id).used, 150);
});

test('预留按用户隔离，重复结算/释放不会重复计费', () => {
  const a = account(145).user; const b = account(145).user;
  const first = reserveQuota(a.id, '文案'); const second = reserveQuota(b.id, '文案');
  assert.equal(snapshot(a.id).left, 0); assert.equal(snapshot(b.id).left, 0);
  first.settle(2000); first.settle(2000); first.release();
  assert.equal(snapshot(a.id).used, 146); assert.equal(snapshot(a.id).reserved, 0);
  second.release(); second.release(); assert.equal(snapshot(b.id).left, 5);
});

test('图片请求也预留配额，失败后释放', async () => {
  const { user, req } = account(1986, 'pro');
  const draft = article(user);
  Drafts.setIllus(draft.id, user.id, { __main__: { items: [{ prompt: 'landscape' }] } });
  const waiting = [];
  globalThis.fetch = () => new Promise((r) => { waiting.push(r); });
  const first = handleIllusImage(req, response(), {}, { id: draft.id, i: 0 });
  const second = handleIllusImage(req, response(), {}, { id: draft.id, i: 0 });
  const results = Promise.allSettled([first, second]);
  waiting.forEach((release) => release(new Response('failed', { status: 500 })));
  const settled = await results;
  assert.equal(waiting.length, 1);
  assert.equal(settled[1].reason.status, 402);
  assert.equal(snapshot(user.id).left, 14);
});

test('配额不足时重新生成保留旧稿', async () => {
  const { user, req } = account(150);
  const draft = article(user);
  const res = response();
  try { await handleContent(req, res, { index: 0 }, { id: draft.id }); }
  catch (err) { assert.equal(err.status, 402); }
  const saved = Drafts.byId(draft.id, user.id);
  assert.equal(saved.content, '已编辑保存的正文');
  assert.equal(saved.status, 'done');
});

test('流式上游错误不能把残缺正文标为完成', async () => {
  const { user, req } = account();
  const draft = article(user);
  globalThis.fetch = async () => sse('data: {"choices":[{"delta":{"content":"残缺正文"}}]}\n\n'
    + 'data: {"error":{"message":"upstream failed"}}\n\n');
  const res = response();
  await handleContent(req, res, { index: 0 }, { id: draft.id });
  assert(res.chunks.some((s) => s.includes('event: error')));
  assert(!res.chunks.some((s) => s.includes('event: done')));
  assert.equal(Drafts.byId(draft.id, user.id).content, '已编辑保存的正文');
  assert.equal(snapshot(user.id).left, 150);
});

test('没有结束标记的流式输出应报错', async () => {
  globalThis.fetch = async () => sse('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
  await assert.rejects(streamText({ system: 'test', user: 'test', onDelta() {} }));
});

test('输出被 token 上限截断时不能接受为完整正文', async () => {
  globalThis.fetch = async () => sse('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n');
  await assert.rejects(streamText({ system: 'test', user: 'test', onDelta() {} }), /length/);
});

test('客户端断开连接会取消生成并保留旧稿、释放配额', async () => {
  const { user, req } = account(); const draft = article(user); const res = response();
  globalThis.fetch = async (url, { signal }) => new Response(new ReadableStream({ start(c) {
    signal.addEventListener('abort', () => c.error(signal.reason), { once: true });
    c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
  } }));
  res.write = (s) => { res.chunks.push(s); if (s.includes('event: delta')) res.emit('close'); };
  await handleContent(req, res, { index: 0 }, { id: draft.id });
  assert.equal(Drafts.byId(draft.id, user.id).content, '已编辑保存的正文');
  assert.equal(snapshot(user.id).left, 150); assert.equal(res.listenerCount('close'), 0);
  assert(!res.chunks.some((s) => s.includes('event: done')));
});

test('正常流支持分块、CRLF、尾部用量并结算真实 token', async () => {
  const { user } = account();
  const payload = 'data: {"choices":[{"delta":{"content":"完整正文"},"finish_reason":null}]}\r\n\r\n'
    + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\n\r\n'
    + 'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":1000}}\r\n\r\n'
    + 'data: [DONE]';
  const bytes = new TextEncoder().encode(payload);
  globalThis.fetch = async () => new Response(new ReadableStream({ start(c) {
    for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
    c.close();
  } }));
  let text = '';
  const full = await streamText({ system: 'test', user: 'test', onDelta: (s) => { text += s; },
    meta: { userId: user.id, feature: '成稿' } });
  assert.equal(full, '完整正文'); assert.equal(text, full);
  assert.equal(snapshot(user.id).used, 1);
});

test('微信下单可在 ESM 下生成有效签名', async () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.PAY_PROVIDER = 'wechat';
  process.env.WX_MCHID = 'test-merchant'; process.env.WX_APPID = 'test-app';
  process.env.WX_PRIVATE_KEY = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  process.env.WX_CERT_SERIAL = 'test-serial'; process.env.PAY_NOTIFY_BASE = 'https://example.test';
  globalThis.fetch = async (url, opts) => {
    const fields = Object.fromEntries([...opts.headers.Authorization.matchAll(/(\w+)="([^"]+)"/g)].map((m) => [m[1], m[2]]));
    const base = `POST\n${new URL(url).pathname}\n${fields.timestamp}\n${fields.nonce_str}\n${opts.body}\n`;
    assert(createVerify('RSA-SHA256').update(base).end().verify(pair.publicKey, fields.signature, 'base64'));
    return Response.json({ code_url: 'weixin://test' });
  };
  assert.deepEqual(await createPayment({ channel: 'wechat', no: 'order-test', amount: 4900, subject: 'test' }), { codeUrl: 'weixin://test' });
});

test('支付宝回调接受有效签名，拒绝篡改', () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.PAY_PROVIDER = 'alipay';
  process.env.ALI_PUBLIC_KEY = pair.publicKey.export({ type: 'spki', format: 'pem' });
  const p = { out_trade_no: 'order-test', trade_no: 'txn-test', total_amount: '49.00', trade_status: 'TRADE_SUCCESS' };
  const base = Object.keys(p).sort().map((k) => `${k}=${p[k]}`).join('&');
  p.sign = createSign('RSA-SHA256').update(base).end().sign(pair.privateKey, 'base64'); p.sign_type = 'RSA2';
  const verify = () => verifyNotify('alipay', { headers: {}, rawBody: new URLSearchParams(p).toString() });
  assert.equal(verify()?.amount, 4900);
  p.total_amount = '0.01'; assert.equal(verify(), null);
});

test('微信回调可解密有效 resource，拒绝篡改', () => {
  process.env.PAY_PROVIDER = 'wechat'; process.env.WX_API_V3_KEY = '0123456789abcdef0123456789abcdef';
  const nonce = 'test-nonce12'; const aad = 'transaction';
  const cipher = createCipheriv('aes-256-gcm', process.env.WX_API_V3_KEY, nonce);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ trade_state: 'SUCCESS', out_trade_no: 'order-test',
    transaction_id: 'txn-test', amount: { total: 4900 } })), cipher.final(), cipher.getAuthTag()]);
  const resource = { nonce, associated_data: aad, ciphertext: ciphertext.toString('base64') };
  const verify = () => verifyNotify('wechat', { headers: {}, rawBody: JSON.stringify({ resource }) });
  assert.equal(verify()?.amount, 4900);
  ciphertext[0] ^= 1; resource.ciphertext = ciphertext.toString('base64'); assert.equal(verify(), null);
});

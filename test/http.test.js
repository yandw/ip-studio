import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { once } from 'node:events';

const root = fileURLToPath(new URL('..', import.meta.url));
async function server(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ip-studio-http-'));
  // 副本中没有本地 .env；测试服务和用户真实数据完全隔离。
  cpSync(join(root, 'server'), join(dir, 'server'), { recursive: true });
  cpSync(join(root, 'package.json'), join(dir, 'package.json'));
  symlinkSync(join(root, 'public'), join(dir, 'public'), 'dir');
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
  const bootstrap = "import { createServer } from 'node:http'; const s=createServer(); s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(async()=>{process.env.PORT=String(port);await import('./server/index.js');});});";
  const child = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], {
    cwd: dir, env: { ...process.env, DB_PATH: join(dir, 'app.db'), LLM_PROVIDER: 'mock', IMAGE_PROVIDER: 'mock', PAY_PROVIDER: 'mock' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
    rmSync(dir, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('test server start timeout')), 5000);
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('test server exited')); });
    child.stdout.on('data', (s) => {
      output += s;
      const match = output.match(/http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
  });
  const base = `http://127.0.0.1:${port}`;
  return { child, base, port };
}

function rawRequest(port, path, headers) {
  return new Promise((resolve) => {
    const req = request({ hostname: '127.0.0.1', port, path, headers }, (res) => {
      res.resume(); res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('error', (err) => resolve({ error: err.code })); req.end();
  });
}
async function register(base) {
  const res = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'test-user', password: 'test-password' }) });
  assert.equal(res.status, 200); await res.json();
  return res.headers.get('set-cookie').split(';')[0];
}

test('非法 Host 返回 400，服务继续响应', async (t) => {
  const { port, base } = await server(t);
  assert.equal((await rawRequest(port, '/api/meta', { Host: '[' })).status, 400);
  assert.equal((await fetch(`${base}/api/meta`)).status, 200);
});

test('非法媒体路径编码返回 400，服务继续响应', async (t) => {
  const { port, base } = await server(t); const cookie = await register(base);
  assert.equal((await rawRequest(port, '/image/1/%ZZ', { Cookie: cookie })).status, 400);
  assert.equal((await fetch(`${base}/api/meta`)).status, 200);
});

test('演示模式的创作、保存、权限隔离与支付幂等仍正常', async (t) => {
  const { base } = await server(t); const cookie = await register(base);
  const call = async (path, method = 'GET', body) => {
    const res = await fetch(base + path, { method, headers: { cookie, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(res.status, 200); return res.json();
  };
  const { draft } = await call('/api/drafts/topics', 'POST', { subject: '工作复盘习惯' });
  assert.equal(draft.topics.length, 3);
  const res = await fetch(`${base}/api/drafts/${draft.id}/content`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{"index":0}' });
  const events = await res.text(); assert(events.includes('event: done'));
  const generated = (await call(`/api/drafts/${draft.id}`)).draft;
  assert.equal(generated.status, 'done'); assert(generated.content.length > 0);
  await call(`/api/drafts/${draft.id}/content`, 'PUT', { content: '手工编辑正文' });
  assert.equal((await call(`/api/drafts/${draft.id}`)).draft.content, '手工编辑正文');
  assert.equal((await fetch(`${base}/api/drafts/${draft.id}`)).status, 401);
  const order = await call('/api/pay/order', 'POST', { plan: 'pro', channel: 'wechat' });
  const notify = `${base}/api/pay/notify/mock?no=${order.no}&amount=${order.amount}&token=${order.mockToken}`;
  for (let i = 0; i < 2; i++) assert.equal((await fetch(notify, { method: 'POST' })).status, 200);
  const paid = await call(`/api/pay/order/${order.no}`);
  assert.equal(paid.order.status, 'granted'); assert.equal(paid.quota.plan, 'pro');
});

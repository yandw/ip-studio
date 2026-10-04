import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
// 执行应用实际使用的保存逻辑；只替换 DOM、定时器和网络边界。
const block = app.slice(app.indexOf('/* ---------------- 保存 ---------------- */'),
  app.indexOf("el.editor.addEventListener('compositionend'"));
function harness() {
  const state = { dirty: false, draft: { id: 1, content: '初稿' }, mode: 'edit' };
  const requests = []; const handlers = {}; const timers = new Map(); let timerId = 0;
  const context = vm.createContext({ state, el: { saveState: {}, saveBtn: { addEventListener() {} },
    briefForm: { reset() {} }, hotRef: { classList: { add() {} } }, sectionInputs: { classList: { add() {} } } },
    clearTimeout: (id) => timers.delete(id), setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; },
    window: { addEventListener: (event, fn) => { handlers[event] = fn; } },
    loadHistory() {}, renderCues() {}, toast() {}, goStep() {}, applyPersonaDefaults() {}, loadSections() {}, loadIdeas() {}, loadPool() {},
    api: (path, opts) => new Promise((resolve, reject) => requests.push({ path, content: opts.body.content, resolve, reject })),
  });
  vm.runInContext(block + '\n' + app.match(/function resetBrief\(\) \{[\s\S]*?\n\}/)[0], context);
  return { state, requests, handlers, timers, markDirty: context.markDirty, flushSave: context.flushSave, resetBrief: context.resetBrief };
}
const tick = () => new Promise((r) => setImmediate(r));

test('保存期间的新编辑不会被旧响应覆盖，保存请求按顺序执行', async () => {
  const h = harness(); h.state.draft.content = '旧编辑'; h.markDirty();
  const first = h.flushSave(); await tick();
  h.state.draft.content = '新编辑'; h.markDirty();
  const second = h.flushSave(); await tick();
  assert.equal(h.requests.length, 1);
  h.requests[0].resolve({ draft: { id: 1, content: '旧编辑' } }); await first; await tick();
  assert.equal(h.state.draft.content, '新编辑');
  assert.equal(h.requests[1].content, '新编辑');
  h.requests[1].resolve({ draft: { id: 1, content: '新编辑' } }); await second;
  assert.equal(h.state.draft.content, '新编辑'); assert.equal(h.state.dirty, false);
});

test('旧稿保存完成不会替换新选中的草稿', async () => {
  const h = harness(); h.markDirty(); const saving = h.flushSave(); await tick();
  h.state.draft = { id: 2, content: '第二篇' }; h.state.dirty = false;
  h.requests[0].resolve({ draft: { id: 1, content: '初稿' } }); await saving;
  assert.equal(h.state.draft.id, 2); assert.equal(h.state.draft.content, '第二篇');
});

test('请求未完成时关闭页面仍提醒，失败后保留未保存状态', async () => {
  const h = harness(); h.markDirty(); const saving = h.flushSave(); await tick();
  let prevented = false; h.handlers.beforeunload({ preventDefault() { prevented = true; } });
  assert(prevented);
  h.requests[0].reject(new Error('offline')); await saving;
  assert.equal(h.state.dirty, true); assert.equal(h.state.draft.content, '初稿');
});

test('await flushSave 等待已经在途的保存', async () => {
  const h = harness(); h.markDirty(); const saving = h.flushSave(); await tick();
  let finished = false; const waiting = h.flushSave().then(() => { finished = true; });
  await tick(); assert.equal(finished, false);
  h.requests[0].resolve({ draft: { id: 1, content: '初稿' } }); await saving; await waiting;
  assert(finished);
});

test('尚未触发定时保存时新建创作，仍先保存上一稿', async () => {
  const h = harness(); h.state.draft.content = '最后的修改'; h.markDirty();
  h.resetBrief(); await tick();
  assert.equal(h.state.draft, null); assert.equal(h.requests[0].path, '/drafts/1/content');
  assert.equal(h.requests[0].content, '最后的修改');
  h.requests[0].resolve({ draft: { id: 1, content: '最后的修改' } }); await tick();
  assert.equal(h.state.draft, null); assert.equal(h.state.dirty, false);
});

test('旧保存失败不会把新编辑误标成已保存', async () => {
  const h = harness(); h.markDirty(); const saving = h.flushSave(); await tick();
  h.state.draft.content = '新编辑'; h.markDirty(); h.requests[0].reject(new Error('offline')); await saving;
  assert.equal(h.state.dirty, true); assert.equal(h.state.draft.content, '新编辑');
  const retry = h.flushSave(); await tick(); assert.equal(h.requests[1].content, '新编辑');
  h.requests[1].resolve({ draft: { id: 1, content: '新编辑' } }); await retry;
  assert.equal(h.state.dirty, false);
});

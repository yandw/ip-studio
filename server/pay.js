/* 支付接入层
 *   wechat —— 微信支付 Native（扫码），v3 接口
 *   alipay —— 支付宝当面付（扫码）
 *   mock   —— 本地假支付，没有商户号也能把整条流程跑通
 *
 * 两家都需要**企业主体 + 对公账户 + 已备案域名**，个人开发者申请不下来
 *（个体工商户可以，但仍要执照）。所以抽象在这里，资质下来只换实现。
 *
 * 支付这块和别的接入层不一样，有几条错了就会丢钱的规则，都写在代码里了：
 *   1. 回调必须验签——不验签等于任何人都能伪造"支付成功"
 *   2. 回调金额必须和订单金额比对——不能信任回调带来的数字
 *   3. 发货必须幂等——回调会重复推送，微信最多推 15 次
 *   4. 回调可能丢——必须能主动查单补偿，不能只等推送
 */

import { createDecipheriv, createHmac, createSign, createVerify, randomUUID, timingSafeEqual } from 'node:crypto';
import { conf } from './settings.js';

/* 配置走 conf()：环境变量优先，后台填的存加密库里兜底。
   每次读而不是缓存——后台改完立刻生效，不用重启。 */
const cfg = () => ({
  provider: (conf('PAY_PROVIDER') || 'mock').toLowerCase(),
  notifyBase: conf('PAY_NOTIFY_BASE'),                // 回调地址的公网前缀
  wx: {
    mchid: conf('WX_MCHID'),
    appid: conf('WX_APPID'),
    serial: conf('WX_CERT_SERIAL'),
    key: conf('WX_API_V3_KEY'),
    privateKey: conf('WX_PRIVATE_KEY'),
  },
  ali: {
    appId: conf('ALI_APP_ID'),
    privateKey: conf('ALI_PRIVATE_KEY'),
    publicKey: conf('ALI_PUBLIC_KEY'),
  },
  mockSecret: process.env.PAY_MOCK_SECRET || 'dev-only',
});

export function payInfo() {
  const c = cfg();
  const ready = {
    wechat: Boolean(c.wx.mchid && c.wx.appid && c.wx.key && c.wx.privateKey),
    alipay: Boolean(c.ali.appId && c.ali.privateKey && c.ali.publicKey),
  };
  return {
    provider: c.provider,
    live: c.provider !== 'mock',
    channels: [
      { key: 'wechat', label: '微信支付', ready: ready.wechat },
      { key: 'alipay', label: '支付宝', ready: ready.alipay },
    ],
    note: c.provider === 'mock'
      ? '演示模式：不会真的扣款，用来把下单→支付→发货整条流程跑通。'
      : '扫码支付。付款后页面会自动刷新套餐，最多等十几秒。',
  };
}

/* 订单号：日期 + 随机。带日期是为了对账时一眼看出是哪天的单 */
export const newTradeNo = () =>
  `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}${randomUUID().replace(/-/g, '').slice(0, 16)}`;

/* 下单，返回给前端用来出二维码的字符串 */
export async function createPayment({ channel, no, amount, subject }) {
  const c = cfg();
  if (c.provider === 'mock') {
    // 假支付：给一个能直接点的"我付好了"链接，签名防止别人替你付
    return { codeUrl: `mock://pay/${no}`, mock: true, mockToken: mockSign(no, amount) };
  }
  if (channel === 'wechat') return wechatNative(c, { no, amount, subject });
  if (channel === 'alipay') return alipayFace(c, { no, amount, subject });
  throw new Error('不支持的支付渠道');
}

/* ---------------- 微信支付 Native ---------------- */
/* v3 用 RSA 签名，签名串是「方法\nURL\n时间戳\n随机串\n请求体\n」。
   这里把请求组装好，真正上线前需要把商户私钥配进环境变量。 */
async function wechatNative(c, { no, amount, subject }) {
  if (!c.wx.mchid) throw new Error('微信支付未配置：缺少商户号');
  const body = {
    appid: c.wx.appid,
    mchid: c.wx.mchid,
    description: subject,
    out_trade_no: no,
    notify_url: `${c.notifyBase}/api/pay/notify/wechat`,
    amount: { total: amount, currency: 'CNY' },
  };
  const res = await fetch('https://api.mch.weixin.qq.com/v3/pay/transactions/native', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: wechatAuth(c, 'POST', '/v3/pay/transactions/native', JSON.stringify(body)),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `微信下单失败 ${res.status}`);
  return { codeUrl: data.code_url };
}

function wechatAuth(c, method, url, bodyStr) {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = randomUUID().replace(/-/g, '');
  const message = `${method}\n${url}\n${ts}\n${nonce}\n${bodyStr}\n`;
  // 商户私钥是 RSA，这里用 node:crypto 的 sign；私钥从环境变量读
  const signature = createSign('RSA-SHA256').update(message).end().sign(c.wx.privateKey, 'base64');
  return `WECHATPAY2-SHA256-RSA2048 mchid="${c.wx.mchid}",nonce_str="${nonce}",`
    + `signature="${signature}",timestamp="${ts}",serial_no="${c.wx.serial}"`;
}

/* ---------------- 支付宝当面付 ---------------- */
async function alipayFace(c, { no, amount, subject }) {
  if (!c.ali.appId) throw new Error('支付宝未配置：缺少 APPID');
  const params = {
    app_id: c.ali.appId,
    method: 'alipay.trade.precreate',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: new Date().toISOString().slice(0, 19).replace('T', ' '),
    version: '1.0',
    notify_url: `${c.notifyBase}/api/pay/notify/alipay`,
    biz_content: JSON.stringify({
      out_trade_no: no, total_amount: (amount / 100).toFixed(2), subject,
    }),
  };
  const base = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  params.sign = createSign('RSA-SHA256').update(base, 'utf8').end().sign(c.ali.privateKey, 'base64');

  const res = await fetch('https://openapi.alipay.com/gateway.do', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  const r = data.alipay_trade_precreate_response;
  if (r?.code !== '10000') throw new Error(r?.sub_msg || r?.msg || '支付宝下单失败');
  return { codeUrl: r.qr_code };
}

/* ---------------- 回调验签 ---------------- */

/* 演示模式的"签名"：HMAC。真实渠道各有各的验签，都在这个函数里分流。
   **验签失败一律当作伪造丢弃**——这是整个支付里最不能省的一步。 */
export function verifyNotify(channel, { headers, rawBody, query }) {
  const c = cfg();
  if (c.provider === 'mock') {
    const token = query?.get?.('token') || '';
    const no = query?.get?.('no') || '';
    const amount = Number(query?.get?.('amount') || 0);
    if (!no || !safeEqual(token, mockSign(no, amount))) return null;
    return { no, tradeNo: `mock-${no}`, amount, raw: 'mock' };
  }

  if (channel === 'wechat') {
    // 真实实现要用微信平台证书验 Wechatpay-Signature，并用 APIv3 密钥解密 resource
    // 未配置密钥时直接拒绝——宁可收不到钱，也不能放进一个伪造的"已支付"
    if (!c.wx.key) return null;
    return decodeWechat(c, headers, rawBody);
  }
  if (channel === 'alipay') {
    if (!c.ali.publicKey) return null;
    return decodeAlipay(c, rawBody);
  }
  return null;
}

function decodeWechat(c, headers, rawBody) {
  try {
    const body = JSON.parse(rawBody);
    const r = body.resource;
    const d = createDecipheriv('aes-256-gcm', c.wx.key, r.nonce);
    d.setAuthTag(Buffer.from(r.ciphertext, 'base64').subarray(-16));
    d.setAAD(Buffer.from(r.associated_data || ''));
    const plain = Buffer.concat([
      d.update(Buffer.from(r.ciphertext, 'base64').subarray(0, -16)),
      d.final(),
    ]).toString('utf8');
    const o = JSON.parse(plain);
    if (o.trade_state !== 'SUCCESS') return null;
    return { no: o.out_trade_no, tradeNo: o.transaction_id, amount: o.amount?.total, raw: plain };
  } catch { return null; }
}

function decodeAlipay(c, rawBody) {
  try {
    const p = Object.fromEntries(new URLSearchParams(rawBody));
    const sign = p.sign;
    delete p.sign; delete p.sign_type;
    const base = Object.keys(p).sort().map((k) => `${k}=${p[k]}`).join('&');
    if (!createVerify('RSA-SHA256').update(base, 'utf8').end().verify(c.ali.publicKey, sign, 'base64')) return null;
    if (!['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(p.trade_status)) return null;
    return { no: p.out_trade_no, tradeNo: p.trade_no, amount: Math.round(Number(p.total_amount) * 100), raw: rawBody };
  } catch { return null; }
}

const mockSign = (no, amount) =>
  createHmac('sha256', cfg().mockSecret).update(`${no}:${amount}`).digest('hex').slice(0, 24);

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/* 回调可能丢——必须能主动查单。定时或用户点"我已支付"时调。 */
export async function queryOrder(channel, no) {
  const c = cfg();
  if (c.provider === 'mock') return { paid: false };
  // 真实实现：微信 GET /v3/pay/transactions/out-trade-no/{no}，支付宝 alipay.trade.query
  return { paid: false, unsupported: true };
}

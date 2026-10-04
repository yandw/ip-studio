/* 配额校验
 *
 * 关键设计：**调用之前拦，不是事后统计**。
 * 事后统计只能告诉你"已经被刷爆了"，拦不住任何东西。
 *
 * 但调用前拿不到真实用量（大模型的 token 数要调完才知道），
 * 所以是"预估预留 + 实际扣减"：先按保守预估锁住额度，
 * 调完拿真实用量结算，失败则释放，避免并发请求反复使用同一份余额。
 */

import { Quota } from './db.js';
import { PLANS, creditsFor, periodOf, planOf } from './plans.js';

/* 预估：拿不到真实用量时按这个判断够不够。宁可估大——估小会让人在余额边缘反复失败 */
const GUESS = {
  文案: 12000,          // token，一次成稿来回的上限量级
  图文配图: 1,
};

// 当前服务是单个 Node 进程：检查和预留同步完成，没有 await 的竞态窗口。
// 在途预留只留在内存；进程退出后不会遗留用户无法使用的锁定额度。
const reserved = new Map();

export class QuotaError extends Error {
  constructor(message, info) {
    super(message);
    this.status = 402;      // Payment Required——和普通 400 分开，前端好识别
    this.info = info;
  }
}

export function snapshot(userId) {
  const period = periodOf();
  const st = Quota.state(userId, period);
  if (!st) return null;
  const plan = planOf(st.plan);
  const pending = reserved.get(userId) || 0;
  return {
    plan: plan.key,
    label: plan.label,
    price: plan.price,
    note: plan.note,
    blocked: plan.blocked,
    total: plan.credits,
    used: st.used,
    reserved: pending,
    left: Math.max(0, plan.credits - st.used - pending),
    period,
  };
}

/* 调用前：这个功能这个套餐能不能用、额度够不够。
   不够就抛 QuotaError，由路由层转成 402。 */
export function assertQuota(userId, feature, units) {
  const s = snapshot(userId);
  if (!s) throw new QuotaError('账号状态异常', {});

  const need = creditsFor(feature, units ?? GUESS[feature] ?? GUESS.文案) || 0;

  if (s.blocked.includes(feature)) {
    throw new QuotaError(
      `${s.label}不包含「${feature}」。升级后可用。`,
      { ...s, feature, upgrade: true },
    );
  }
  if (need > s.left) {
    throw new QuotaError(
      `本月额度不够了（还剩 ${s.left} 点，这次约需 ${need} 点）。下个月 1 号重置，也可以现在升级。`,
      { ...s, feature, need, upgrade: true },
    );
  }
  return { fromPlan: need };
}

/* 调用后：按真实用量扣。预估和实际的差在这里抹平 */
export function consume(userId, feature, units) {
  const credits = creditsFor(feature, units);
  if (!credits) return 0;
  Quota.state(userId, periodOf());
  Quota.consume(userId, credits, 0);
  return credits;
}

/* 在调用上游前预留，成功结算或失败释放。句柄只能结算/释放一次。 */
export function reserveQuota(userId, feature, units) {
  const { fromPlan } = assertQuota(userId, feature, units);
  reserved.set(userId, (reserved.get(userId) || 0) + fromPlan);
  let active = true;
  const release = () => {
    if (!active) return;
    active = false;
    const left = (reserved.get(userId) || 0) - fromPlan;
    if (left > 0) reserved.set(userId, left);
    else reserved.delete(userId);
  };
  return {
    release,
    settle(actualUnits) {
      if (!active) return;
      consume(userId, feature, actualUnits);
      release();
    },
  };
}

export { PLANS };

'use strict';

/**
 * 每日签到结果分类。
 *
 * 服务端复用 code=10001 表达两种完全不同的状态，必须按文案区分：
 *   - 「今日已签到 / 已领取」：今日已完成（幂等成功）
 *   - 「签到活动未开启或已过期」：无活动——绝不是成功，记成成功会让
 *     当日缓存假成功、面板永远显示"已签"、且当天不再重试。
 * HTTP 200 但 body 非 JSON（网关/登录页）由调用方先行过滤，不进入本分类。
 */
const INACTIVE_MESSAGE = /未开启|未开始|未开放|已过期|无.*活动|活动.*(?:结束|关闭|暂停)/i;
const ALREADY_MESSAGE = /已签到|已领取|已经.*(?:签到|领取)|重复签到|already/i;

function numericCode(value) {
  if (value === null || value === undefined || value === '') return null; // 字段缺失 = 服务端未携带 code
  const n = Number(value);
  // 非数字字符串（网关异常体 {code:"error"} 等）必须判失败而不是当作"无 code"放行
  return Number.isFinite(n) ? n : NaN;
}

/**
 * @param {object} input
 * @param {boolean} input.httpOk   HTTP 2xx
 * @param {*}      input.code      服务业务码
 * @param {string} input.message   服务文案（o.msg || o.message）
 * @returns {{ok: boolean, already: boolean, inactive: boolean, reason: string, code: number|null}}
 */
function classifyCheckinResult({ httpOk, code, message }) {
  const normalizedCode = numericCode(code);
  const text = String(message || '');
  const inactive = INACTIVE_MESSAGE.test(text);
  const already = normalizedCode === 10001 && !inactive && ALREADY_MESSAGE.test(text);
  // 已签状态即使服务端返回 4xx（实测 .ai 域以 400 + 10001 表达）也算今日已完成；
  // 无活动状态无论 HTTP 状态一律不算成功。
  const ok = already || (!inactive && !!httpOk && (normalizedCode === 0 || normalizedCode === null));
  let reason = 'checkin-http-error';
  if (ok) reason = 'ok';
  else if (inactive) reason = 'checkin-no-activity';
  return { ok, already, inactive, reason, code: normalizedCode };
}

module.exports = { classifyCheckinResult, INACTIVE_MESSAGE, ALREADY_MESSAGE };

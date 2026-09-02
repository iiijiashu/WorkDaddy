'use strict';

/**
 * WorkDaddy 多渠道登录/签到 修复的离线回归测试。
 *
 * 运行：node --test scripts/test/multichannel.test.js
 * 全程使用临时沙箱（覆盖 LOCALAPPDATA / WBSWITCH_DATA_DIR），不读写真实用户数据。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-test-'));
const SANDBOX_LOCAL = path.join(ROOT, 'AppData', 'Local');
const SANDBOX_AUTH = path.join(SANDBOX_LOCAL, 'CodeBuddyExtension', 'Data', 'Public', 'auth');
const SANDBOX_DATA = path.join(ROOT, 'WorkDaddyData');
fs.mkdirSync(SANDBOX_AUTH, { recursive: true });

// lib.js 在 require 时解析路径，必须先覆盖环境变量再加载
process.env.LOCALAPPDATA = SANDBOX_LOCAL;
process.env.WBSWITCH_DATA_DIR = SANDBOX_DATA;
delete process.env.WBSWITCH_AUTH_FILE;

const lib = require('../lib.js');
const { classifyCheckinResult } = require('../checkin-result.js');

const AI_REALM = 'https://www.workbuddy.ai/auth/realms/copilot';
const CN_REALM = 'https://www.codebuddy.cn/auth/realms/copilot';
const NOW = Date.now();

function fakeJwt(iss) {
  const header = Buffer.from('{"alg":"RS256"}').toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss })).toString('base64url');
  return `${header}.${payload}.signature`;
}

function writeAuth(name, { uid, nickname, iss, lastRefreshTime, lastLogin = true }) {
  const body = {
    account: { uid, nickname, lastLogin },
    auth: { accessToken: fakeJwt(iss), lastRefreshTime, expiresAt: NOW + 30 * 24 * 3600 * 1000 },
  };
  fs.writeFileSync(path.join(SANDBOX_AUTH, name), JSON.stringify(body));
}

test.after(() => {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {}
});

test('checkin-result: 10001 语义按文案区分', () => {
  // 无活动（实测 .ai 域返回 HTTP 400 + 10001 + 此文案）→ 绝不能算成功
  const inactive = classifyCheckinResult({ httpOk: false, code: 10001, message: '签到活动未开启或已过期' });
  assert.equal(inactive.ok, false);
  assert.equal(inactive.already, false);
  assert.equal(inactive.inactive, true);
  assert.equal(inactive.reason, 'checkin-no-activity');

  // 活动已结束（即使 HTTP 200）也不算成功
  const ended = classifyCheckinResult({ httpOk: true, code: 10001, message: '该活动已结束' });
  assert.equal(ended.ok, false);
  assert.equal(ended.inactive, true);

  // 已签（HTTP 200 + 10001 + 明确文案）→ 幂等成功
  const already = classifyCheckinResult({ httpOk: true, code: 10001, message: '今天已签到，请明天再来' });
  assert.equal(already.ok, true);
  assert.equal(already.already, true);
  assert.equal(already.reason, 'ok');

  // 已签但服务端用 4xx 表达（幂等成功，不丢状态）
  const already400 = classifyCheckinResult({ httpOk: false, code: 10001, message: '重复签到' });
  assert.equal(already400.ok, true);
  assert.equal(already400.already, true);

  // 真正成功
  const ok = classifyCheckinResult({ httpOk: true, code: 0, message: 'OK' });
  assert.equal(ok.ok, true);
  assert.equal(ok.already, false);

  // 10001 但文案不含任何已知关键词 → 不敢认定成功
  const unknown = classifyCheckinResult({ httpOk: true, code: 10001, message: 'some unknown text' });
  assert.equal(unknown.ok, false);

  // 字符串数字码
  const strCode = classifyCheckinResult({ httpOk: true, code: '0', message: 'OK' });
  assert.equal(strCode.ok, true);
  assert.equal(strCode.code, 0);

  // 非数字 code（网关异常体）+ HTTP 200 → 绝不能当成功缓存
  const badCode = classifyCheckinResult({ httpOk: true, code: 'internal-error', message: 'x' });
  assert.equal(badCode.ok, false);
});

test('lib: listAuthFiles 只收录活动渠道文件', () => {
  writeAuth('workbuddy-desktop-ai.info', { uid: 'uid-ai', nickname: 'ai账号', iss: AI_REALM, lastRefreshTime: NOW - 3600e3 });
  writeAuth('Tencent-Cloud.coding-copilot.info', { uid: 'uid-cn', nickname: 'cn账号', iss: CN_REALM, lastRefreshTime: NOW });
  // 应用自己的时间戳快照（必须排除；含带 Z 与本地时间两种命名）
  fs.writeFileSync(
    path.join(SANDBOX_AUTH, 'workbuddy-desktop-ai.2026-08-21T03-08-07-960Z.39252.e2114071-6bf9-4fc3-b7b3-dc4ce2b8a475.info'),
    '{"account":{"uid":"uid-ai"}}'
  );
  fs.writeFileSync(
    path.join(SANDBOX_AUTH, 'workbuddy-desktop-ai.2026-08-30T04-23-33-059.43140.3d40b067-88d8-4ff0-a1d2-f1e11c063db9.info'),
    '{"account":{"uid":"uid-ai"}}'
  );
  // 临时文件与无关文件（必须排除）
  fs.writeFileSync(path.join(SANDBOX_AUTH, 'workbuddy-desktop-ai.info.tmp'), '{}');
  fs.writeFileSync(path.join(SANDBOX_AUTH, 'notes.txt'), 'x');

  const names = lib.listAuthFiles().map((f) => path.basename(f)).sort();
  assert.deepEqual(names, ['Tencent-Cloud.coding-copilot.info', 'workbuddy-desktop-ai.info']);
});

test('lib: currentAuthFile 取最新数据，陈旧 lastLogin 不干扰', () => {
  // 陈旧的 lastLogin:true 渠道文件（1 小时前登录过然后登出）
  writeAuth('old-channel.info', { uid: 'uid-old', nickname: '旧账号', iss: 'https://old.example.com/auth/realms/x', lastRefreshTime: NOW - 3600e3, lastLogin: true });
  // 最新写入的是腾讯云渠道
  assert.equal(path.basename(lib.currentAuthFile()), 'Tencent-Cloud.coding-copilot.info');
});

test('lib: backupCurrent 备份全部渠道账号且不降级', () => {
  const info = lib.backupCurrent(SANDBOX_DATA, () => {});
  assert.equal(info.uid, 'uid-cn'); // 当前账号是腾讯渠道
  const accounts = lib.listAccounts(SANDBOX_DATA).map((a) => a.uid).sort();
  assert.deepEqual(accounts, ['uid-ai', 'uid-cn', 'uid-old']);

  // 源文件被回写旧时间戳时，已有较新备份不降级
  const backupFile = path.join(SANDBOX_DATA, 'accounts', 'uid-cn.info');
  const before = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
  writeAuth('Tencent-Cloud.coding-copilot.info', { uid: 'uid-cn', nickname: 'cn账号', iss: CN_REALM, lastRefreshTime: NOW - 7200e3 });
  lib.backupCurrent(SANDBOX_DATA, () => {});
  const after = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
  assert.equal(after.auth.lastRefreshTime, before.auth.lastRefreshTime, '备份不应被更旧的源覆盖');

  // 恢复新时间戳，保证后续用例状态一致
  writeAuth('Tencent-Cloud.coding-copilot.info', { uid: 'uid-cn', nickname: 'cn账号', iss: CN_REALM, lastRefreshTime: NOW });
});

test('lib: switchTo 按 realm 写回原始渠道文件', () => {
  lib.backupCurrent(SANDBOX_DATA, () => {});

  // 当前登录是腾讯渠道；切回 .ai 账号必须写回 workbuddy-desktop-ai.info，
  // 绝不能把 .ai realm 的数据覆写进腾讯云渠道文件
  lib.switchTo(SANDBOX_DATA, 'uid-ai', () => {});
  const aiFile = JSON.parse(fs.readFileSync(path.join(SANDBOX_AUTH, 'workbuddy-desktop-ai.info'), 'utf8'));
  const cnFile = JSON.parse(fs.readFileSync(path.join(SANDBOX_AUTH, 'Tencent-Cloud.coding-copilot.info'), 'utf8'));
  assert.equal(aiFile.account.uid, 'uid-ai');
  assert.equal(cnFile.account.uid, 'uid-cn', '当前渠道文件不应被跨 realm 覆写');

  // 切回腾讯账号 → 写回腾讯渠道文件
  lib.switchTo(SANDBOX_DATA, 'uid-cn', () => {});
  const cnAgain = JSON.parse(fs.readFileSync(path.join(SANDBOX_AUTH, 'Tencent-Cloud.coding-copilot.info'), 'utf8'));
  assert.equal(cnAgain.account.uid, 'uid-cn');
});

test('lib: switchTo 未知 realm 回退当前文件', () => {
  // 构造一个 realm 在现有渠道文件中不存在的备份
  const unknownBody = {
    account: { uid: 'uid-unknown', nickname: '未知渠道账号', lastLogin: true },
    auth: { accessToken: fakeJwt('https://unknown.example.com/auth/realms/x'), lastRefreshTime: NOW },
  };
  fs.writeFileSync(path.join(SANDBOX_DATA, 'accounts', 'uid-unknown.info'), JSON.stringify(unknownBody));
  const warnings = [];
  lib.switchTo(SANDBOX_DATA, 'uid-unknown', (m) => warnings.push(m));
  const current = JSON.parse(fs.readFileSync(lib.currentAuthFile(), 'utf8'));
  assert.equal(current.account.uid, 'uid-unknown', '无匹配渠道时回退写当前文件');
  assert.ok(warnings.some((m) => m.includes('回退')), '应给出回退告警');
});

test('lib: 损坏的渠道文件不阻塞备份', () => {
  fs.writeFileSync(path.join(SANDBOX_AUTH, 'broken.info'), '{ this is not json');
  // 不应抛异常；损坏文件不产生账号
  const info = lib.backupCurrent(SANDBOX_DATA, () => {});
  assert.ok(info && info.uid);
  const accounts = lib.listAccounts(SANDBOX_DATA).map((a) => a.uid);
  assert.ok(!accounts.includes('broken'));
});

test('lib: authRealm 提取与容错', () => {
  assert.equal(lib.authRealm({ auth: { accessToken: fakeJwt(CN_REALM) } }), 'https://www.codebuddy.cn');
  assert.equal(lib.authRealm({ auth: { accessToken: 'not-a-jwt' } }), null);
  assert.equal(lib.authRealm({}), null);
  assert.equal(lib.authRealm(null), null);
});

test('lib: readAuthFile 返回当前文件路径', () => {
  const info = lib.readAuthFile();
  assert.ok(info.file && path.dirname(info.file) === SANDBOX_AUTH);
  assert.ok(info.uid);
});

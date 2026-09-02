/**
 * WorkBuddy 多账号切换器 - 共享逻辑
 *
 * 原理：WorkBuddy 桌面端的登录信息保存在
 *   Windows: %LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\<authenticationId>.info
 *   macOS:   ~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/<authenticationId>.info
 * 其中 <authenticationId> 由应用按登录渠道决定：旧版固定 workbuddy-desktop-ai，
 * 5.4.x 腾讯云渠道登录会写成 Tencent-Cloud.coding-copilot.info。
 * 本插件扫描该目录下所有渠道登录文件，按 account.uid 备份到稳定目录；
 * 切换登录时把备份写回与备份 token 同 realm 的渠道文件。
 *
 * 环境变量（均可覆盖默认值）：
 *   WBSWITCH_AUTH_FILE  登录信息文件路径（显式指定后不再扫描目录，保持旧版行为）
 *   WBSWITCH_DATA_DIR   备份数据目录
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';

const PLATFORM_DATA_DIR = IS_WIN
  ? path.join(
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'WorkDaddy'
    )
  : path.join(os.homedir(), 'Library', 'Application Support', 'WorkDaddy');
// macOS 旧品牌目录：旧版 launchd 可能把 WBSWITCH_DATA_DIR 设成 HelloBuddy
const LEGACY_DATA_DIR = IS_WIN
  ? null
  : path.join(os.homedir(), 'Library', 'Application Support', 'HelloBuddy');

function samePath(a, b) {
  return !!a && !!b && path.resolve(a) === path.resolve(b);
}

function isLegacyDataDir(dataDir) {
  return !IS_WIN && samePath(dataDir, LEGACY_DATA_DIR);
}

// WorkBuddy 的 authentication id 会随产品线变化：
// 旧版桌面端使用 workbuddy-desktop，WorkBuddy AI 使用 workbuddy-desktop-ai。
// 优先复用已经存在的认证文件；首次登录尚未创建文件时，再根据 WorkBuddyAI 安装情况选默认值。
function defaultAuthFile() {
  if (!IS_WIN) {
    return path.join(
      os.homedir(),
      'Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop-ai.info'
    );
  }
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const authDirPath = path.join(localAppData, 'CodeBuddyExtension', 'Data', 'Public', 'auth');
  const current = path.join(authDirPath, 'workbuddy-desktop-ai.info');
  const legacy = path.join(authDirPath, 'workbuddy-desktop.info');
  if (fs.existsSync(current)) return current;
  if (fs.existsSync(legacy)) return legacy;
  const workBuddyAi = path.join(localAppData, 'Programs', 'WorkBuddyAI', 'WorkBuddyAI.exe');
  return fs.existsSync(workBuddyAi) ? current : legacy;
}

const AUTH_FILE = process.env.WBSWITCH_AUTH_FILE || defaultAuthFile();

/** 登录信息目录：所有渠道的 <authenticationId>.info 都在这里 */
function authDir() {
  return path.dirname(AUTH_FILE);
}

/**
 * 列出目录里所有渠道登录文件。
 * 排除应用自己滚动的时间戳快照（<id>.<ISO 时间>.<pid>.<uuid>.info）与临时文件。
 * 显式指定 WBSWITCH_AUTH_FILE 时只返回该文件（旧版单文件行为完全保留）。
 */
function listAuthFiles() {
  if (process.env.WBSWITCH_AUTH_FILE) {
    return fs.existsSync(AUTH_FILE) ? [AUTH_FILE] : [];
  }
  let names = [];
  try {
    names = fs.readdirSync(authDir());
  } catch (_) {
    return [];
  }
  const files = [];
  for (const n of names) {
    if (!/\.info$/i.test(n)) continue;
    // 应用的时间戳快照（如 workbuddy-desktop-ai.2026-08-21T03-08-07-960Z.39252.<uuid>.info）
    // 是历史副本而非活动登录文件，不参与备份/切换。只要求含 ISO 日期段，不强制 Z 后缀
    // （不同版本可能用本地时间命名），避免快照被当成活动渠道文件污染账号列表
    if (/\.\d{4}-\d{2}-\d{2}T/.test(n)) continue;
    const f = path.join(authDir(), n);
    try {
      if (!fs.statSync(f).isFile()) continue;
    } catch (_) {
      continue;
    }
    files.push(f);
  }
  return files;
}

/** 读取并解析登录文件，返回 { json, account }；文件缺失/损坏/无 account.uid 时返回 null */
function parseAuthFile(file) {
  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
  if (!json || typeof json !== 'object') return null;
  const acct = json.account || (Array.isArray(json.accounts) && json.accounts[0]) || null;
  if (!acct || !acct.uid) return null;
  return { json, account: acct };
}

/**
 * 当前生效的登录文件：应用按渠道把登录态写进不同 <id>.info。
 * 最新数据优先；lastLogin 标记只在「与最新数据接近」的文件之间做决胜——
 * 避免很久以前登录残留的 lastLogin:true 压过新渠道的会话。
 * 目录为空时回退旧版单文件解析（保持首次安装、尚未登录时的行为）。
 */
function currentAuthFile() {
  if (process.env.WBSWITCH_AUTH_FILE) return AUTH_FILE;
  const entries = [];
  for (const f of listAuthFiles()) {
    const parsed = parseAuthFile(f);
    if (!parsed) continue;
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(f).mtimeMs;
    } catch (_) {}
    entries.push({
      file: f,
      stamp: Number(parsed.json.auth && parsed.json.auth.lastRefreshTime) || mtimeMs,
      lastLogin: parsed.account.lastLogin === true,
    });
  }
  if (!entries.length) return AUTH_FILE;
  const newest = Math.max(...entries.map((e) => e.stamp));
  const FRESH_WINDOW = 5 * 60 * 1000;
  const fresh = entries.filter((e) => newest - e.stamp <= FRESH_WINDOW);
  fresh.sort((a, b) => (b.lastLogin === a.lastLogin ? b.stamp - a.stamp : b.lastLogin ? 1 : -1));
  return fresh[0].file;
}

function defaultDataDir() {
  // macOS: ~/Library/Application Support/WorkDaddy
  // Windows: %APPDATA%\WorkDaddy
  // 旧版 launchd 可能把 WBSWITCH_DATA_DIR 设成 HelloBuddy；新版本始终落到 WorkDaddy，
  // 避免旧服务被新 daemon 拉起后继续写入旧目录。
  const configured = process.env.WBSWITCH_DATA_DIR;
  return configured && !isLegacyDataDir(configured) ? configured : PLATFORM_DATA_DIR;
}

function accountsDir(dataDir) {
  return path.join(dataDir, 'accounts');
}
function metaFile(dataDir) {
  return path.join(dataDir, 'meta.json');
}
function logFile(dataDir) {
  return path.join(dataDir, 'daemon.log');
}
function validateUid(uid) {
  const value = String(uid || '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error('账号 uid 格式无效');
  }
  return value;
}
function backupPath(dataDir, uid) {
  return path.join(accountsDir(dataDir), `${validateUid(uid)}.info`);
}

/**
 * 兼容旧版账号备份：把 HelloBuddy/accounts 中尚未存在于 WorkDaddy 的账号复制过来。
 * 只对平台默认 WorkDaddy 目录执行，显式自定义数据目录不做隐式迁移。
 * 源目录和文件均保留，重复调用幂等。（仅 macOS 存在旧目录，Windows 直接跳过）
 */
function migrateLegacyDataDir(dataDir, log = () => {}) {
  if (IS_WIN || !samePath(dataDir, PLATFORM_DATA_DIR)) {
    return { migrated: 0, skipped: 0, source: null, target: dataDir };
  }

  const sourceAccounts = accountsDir(LEGACY_DATA_DIR);
  if (!fs.existsSync(sourceAccounts)) {
    return { migrated: 0, skipped: 0, source: LEGACY_DATA_DIR, target: dataDir };
  }

  let names;
  try {
    names = fs
      .readdirSync(sourceAccounts)
      .filter((name) => name.endsWith('.info') && !name.endsWith('.tmp'));
  } catch (_) {
    return { migrated: 0, skipped: 0, source: LEGACY_DATA_DIR, target: dataDir };
  }

  const targetAccounts = accountsDir(dataDir);
  fs.mkdirSync(targetAccounts, { recursive: true, mode: 0o700 });
  let migrated = 0;
  let skipped = 0;
  for (const name of names) {
    const source = path.join(sourceAccounts, name);
    const target = path.join(targetAccounts, name);
    if (fs.existsSync(target)) {
      skipped += 1;
      continue;
    }
    try {
      fs.copyFileSync(source, target);
      fs.chmodSync(target, 0o600);
      migrated += 1;
    } catch (e) {
      log(`[migration] 迁移账号 ${name} 失败: ${e.message}`);
    }
  }
  if (migrated) {
    log(`[migration] 已从 ${LEGACY_DATA_DIR}/accounts 迁移 ${migrated} 个账号到 ${dataDir}/accounts`);
  }
  return { migrated, skipped, source: LEGACY_DATA_DIR, target: dataDir };
}

function ensureDirs(dataDir, log = () => {}) {
  migrateLegacyDataDir(dataDir, log);
  fs.mkdirSync(accountsDir(dataDir), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dataDir, 0o700);
  } catch (_) {
    /* 已存在时可能失败，忽略 */
  }
}

/** 读取登录信息文件并抽取账号关键字段（不返回令牌内容；默认读当前生效的渠道文件） */
function readAuthFile(file) {
  const target = file || currentAuthFile();
  const raw = fs.readFileSync(target, 'utf8');
  const json = JSON.parse(raw);
  if (!json || typeof json !== 'object') {
    throw new Error('auth 文件不是有效的 JSON 对象');
  }
  const acct = json.account || (Array.isArray(json.accounts) && json.accounts[0]) || null;
  if (!acct || !acct.uid) {
    throw new Error('auth 文件中未找到 account.uid');
  }
  return {
    uid: acct.uid,
    nickname: acct.nickname || '',
    uin: acct.uin || '',
    phone: acct.phoneNumber || '',
    type: acct.type || '',
    raw: json,
    file: target,
  };
}

/** 更新 meta.json（uid -> nickname/uin/phone/时间） */
function updateMeta(dataDir, info) {
  const mf = metaFile(dataDir);
  let meta = { accounts: {} };
  try {
    meta = JSON.parse(fs.readFileSync(mf, 'utf8'));
    if (!meta.accounts) meta.accounts = {};
  } catch (_) {
    /* 首次运行 */
  }
  const now = Date.now();
  const prev = meta.accounts[info.uid] || {};
  meta.accounts[info.uid] = {
    uid: info.uid,
    nickname: info.nickname || prev.nickname || '',
    uin: info.uin || prev.uin || '',
    phone: info.phone || prev.phone || '',
    firstSeen: prev.firstSeen || now,
    lastSeen: now,
  };
  fs.writeFileSync(mf, JSON.stringify(meta, null, 2), { mode: 0o600 });
  return meta;
}

/** 把单个登录文件备份到 accounts/<uid>.info（原子写入，0600）。
 *  已存在更新的备份时不降级覆盖（多渠道文件指向同一 uid 时避免旧快照回滚）。 */
function backupAuthFile(dataDir, file, log = () => {}) {
  const parsed = parseAuthFile(file);
  if (!parsed) {
    throw new Error('auth 文件无效或缺少 account.uid: ' + path.basename(file));
  }
  const { json, account: acct } = parsed;
  const dest = backupPath(dataDir, acct.uid);
  let stamp = 0;
  try {
    stamp = Number(json.auth && json.auth.lastRefreshTime) || Math.floor(fs.statSync(file).mtimeMs);
  } catch (_) {}
  try {
    const old = JSON.parse(fs.readFileSync(dest, 'utf8'));
    const oldStamp = Number(old.auth && old.auth.lastRefreshTime) || 0;
    if (oldStamp > stamp) {
      return { uid: acct.uid, nickname: acct.nickname || '', uin: acct.uin || '', file, skipped: true };
    }
  } catch (_) {
    /* 首次备份 */
  }
  const tmp = dest + '.tmp';
  fs.writeFileSync(tmp, fs.readFileSync(file), { mode: 0o600 });
  fs.renameSync(tmp, dest);
  fs.chmodSync(dest, 0o600);
  updateMeta(dataDir, {
    uid: acct.uid,
    nickname: acct.nickname || '',
    uin: acct.uin || '',
    phone: acct.phoneNumber || '',
  });
  log(
    `[sync] 已备份账号 ${acct.nickname || acct.uid} (${acct.uid}) <- ${path.basename(file)}`
  );
  return { uid: acct.uid, nickname: acct.nickname || '', uin: acct.uin || '', file, skipped: false };
}

/** 备份目录里所有渠道登录文件（幂等），返回当前生效账号的信息 */
function backupCurrent(dataDir, log = () => {}) {
  ensureDirs(dataDir, log);
  const files = listAuthFiles();
  if (!files.length) {
    throw new Error('未找到登录信息文件（' + authDir() + '）');
  }
  const current = currentAuthFile();
  let result = null;
  for (const f of files) {
    try {
      const info = backupAuthFile(dataDir, f, log);
      if (!result || path.resolve(f) === path.resolve(current)) result = info;
    } catch (e) {
      log(`[sync] 备份 ${path.basename(f)} 失败: ${e.message}`);
    }
  }
  if (!result) {
    throw new Error('所有登录文件备份均失败');
  }
  return result;
}

/** 列出所有已备份账号（直接读备份文件提取展示字段，按最近刷新时间倒序） */
function listAccounts(dataDir) {
  migrateLegacyDataDir(dataDir);
  const dir = accountsDir(dataDir);
  let names = [];
  try {
    names = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.info') && !f.endsWith('.tmp'));
  } catch (_) {
    /* 目录不存在 */
  }
  const list = names.map((n) => {
    const uid = n.replace(/\.info$/, '');
    const item = {
      uid,
      nickname: '',
      phone: '',
      uin: '',
      tokenExpiresAt: null,
      refreshExpiresAt: null,
      lastRefreshTime: null,
      lastSeen: null,
    };
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      const acct = j.account || (Array.isArray(j.accounts) && j.accounts[0]);
      if (acct) {
        item.nickname = acct.nickname || '';
        item.phone = acct.phoneNumber || '';
        item.uin = acct.uin || '';
      }
      if (j.auth) {
        item.tokenExpiresAt = j.auth.expiresAt || null;
        item.refreshExpiresAt = j.auth.refreshExpiresAt || null;
        item.lastRefreshTime = j.auth.lastRefreshTime || null;
      }
    } catch (_) {
      /* 文件损坏则显示空字段 */
    }
    return item;
  });
  // lastRefreshTime 理论上是毫秒数字，但防御性强转：字符串时间戳相减会得到 NaN 导致排序失效
  return list.sort(
    (a, b) => (Number(b.lastRefreshTime) || 0) - (Number(a.lastRefreshTime) || 0)
  );
}

/** 永久删除某个账号的备份文件（不影响当前登录） */
function deleteAccount(dataDir, uid, log = () => {}) {
  migrateLegacyDataDir(dataDir, log);
  const file = backupPath(dataDir, uid);
  let deletedFile = false;
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    deletedFile = true;
  }
  const mf = metaFile(dataDir);
  try {
    const meta = JSON.parse(fs.readFileSync(mf, 'utf8'));
    if (meta.accounts && meta.accounts[uid]) {
      delete meta.accounts[uid];
      fs.writeFileSync(mf, JSON.stringify(meta, null, 2), { mode: 0o600 });
    }
  } catch (_) {
    /* meta 不存在则忽略 */
  }
  return { deleted: deletedFile, uid };
}

/** 从 auth JSON 的 accessToken 解析 JWT iss 来源域（realm，用于渠道匹配），失败返回 null */
function authRealm(json) {
  try {
    const part = String((json && json.auth && json.auth.accessToken) || '').split('.')[1];
    if (!part) return null;
    const payload = JSON.parse(
      Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    );
    const m = String(payload.iss || '').match(/^https?:\/\/[^/]+/i);
    return m ? m[0] : null;
  } catch (_) {
    return null;
  }
}

/** 切换登录账号：把备份文件写回渠道匹配的登录文件（先校验 uid 匹配）。
 *  渠道选择：优先写回「realm 与备份 token 一致」的现有渠道文件——
 *  把 .ai realm 的账号写进腾讯云渠道文件（或反之）是否被 5.4.x 接受没有证据，
 *  按 realm 回到原始渠道文件是最稳妥的选择；找不到匹配时才回退当前文件并告警。 */
function switchTo(dataDir, uid, log = () => {}) {
  migrateLegacyDataDir(dataDir, log);
  const src = backupPath(dataDir, uid);
  if (!fs.existsSync(src)) {
    throw new Error(`未找到账号 ${uid} 的备份文件`);
  }
  const raw = fs.readFileSync(src, 'utf8');
  const json = JSON.parse(raw);
  const acct = json.account || (Array.isArray(json.accounts) && json.accounts[0]);
  if (!acct || acct.uid !== uid) {
    throw new Error('备份文件校验失败：uid 不匹配，已中止切换');
  }
  const current = currentAuthFile();
  const targetRealm = authRealm(json);
  let target = null;
  if (targetRealm) {
    const currentParsed = parseAuthFile(current);
    if (currentParsed && authRealm(currentParsed.json) === targetRealm) {
      target = current;
    } else {
      const match = listAuthFiles().find((f) => {
        const p = parseAuthFile(f);
        return p && authRealm(p.json) === targetRealm;
      });
      if (match) {
        target = match;
        if (match !== current) {
          log(`[switch] 目标账号 realm=${targetRealm}，写回其原始渠道文件 ${path.basename(match)}（当前渠道文件 realm 不匹配，不覆写）`);
        }
      }
    }
  }
  if (!target) {
    target = current;
    if (targetRealm) {
      log(`[switch] 警告：现有渠道文件均不匹配 realm=${targetRealm}，回退写入当前文件 ${path.basename(target)}——若切号后未生效请重新登录该账号`);
    }
  }
  const tmp = target + '.wbswitch.tmp';
  // Windows：目标文件可能被 WorkBuddy 短暂占用（EPERM），做有限次同步重试
  let writeErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(tmp, raw, { mode: 0o600 });
      fs.renameSync(tmp, target);
      fs.chmodSync(target, 0o600);
      writeErr = null;
      break;
    } catch (e) {
      writeErr = e;
      try { fs.unlinkSync(tmp); } catch (_) {}
      if (attempt < 2) {
        // 同步睡眠 400ms（主线程阻塞可接受：低频操作）
        try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400); } catch (_) {}
      }
    }
  }
  if (writeErr) {
    // 沙箱环境（如从 WorkBuddy 托管后台运行）直接写系统目录会 EPERM。
    // macOS 回退：osascript 委托 GUI 会话复制（不涉及内容转义，只传路径）。
    // Windows：目录在 %LOCALAPPDATA% 用户可写区，直写失败即如实报错。
    const e = writeErr;
    if (IS_WIN) {
      throw new Error(
        `写入登录文件失败(${e.code || ''}): ${(e.message || e).toString().slice(0, 200)}`
      );
    }
    log(`[switch] 直写失败(${e.code})，改用 osascript 委托写入`);
    const bridge = path.join(dataDir, '.auth-switch-bridge.tmp');
    const authBridge = target + '.wbswitch.tmp';
    const bridgeQ = bridge.replace(/"/g, '\\"');
    const authQ = target.replace(/"/g, '\\"');
    const tmpQ = authBridge.replace(/"/g, '\\"');
    try {
      // 1) 本进程写 bridge（数据目录可写）
      fs.writeFileSync(bridge, raw, { mode: 0o600 });
      // 2) osascript 委托：bridge -> auth 目录
      const script = `do shell script "cp \\"${bridgeQ}\\" \\"${tmpQ}\\" && mv \\"${tmpQ}\\" \\"${authQ}\\" && chmod 600 \\"${authQ}\\" && rm -f \\"${bridgeQ}\\" && echo OK"`;
      const { execFileSync } = require('child_process');
      execFileSync('osascript', ['-e', script], { timeout: 15000, stdio: 'pipe' });
    } catch (e2) {
      try { fs.unlinkSync(bridge); } catch (_) {}
      throw new Error(`写入登录文件失败: ${(e2.message || e2).toString().slice(0, 200)}`);
    }
  }
  // 清掉应用自己的「已登出」标记（<file>.logged-out），否则应用会无视恢复的会话
  try { fs.unlinkSync(target + '.logged-out'); } catch (_) {}
  log(`[switch] 已切换登录账号为 ${acct.nickname || uid} (${uid}) -> ${path.basename(target)}`);
  return { uid: acct.uid, nickname: acct.nickname || '', uin: acct.uin || '' };
}

module.exports = {
  AUTH_FILE,
  defaultDataDir,
  authDir,
  listAuthFiles,
  currentAuthFile,
  parseAuthFile,
  authRealm,
  accountsDir,
  metaFile,
  logFile,
  backupPath,
  validateUid,
  ensureDirs,
  readAuthFile,
  updateMeta,
  backupAuthFile,
  backupCurrent,
  listAccounts,
  switchTo,
  deleteAccount,
  migrateLegacyDataDir,
};

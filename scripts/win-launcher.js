#!/usr/bin/env node
/**
 * WorkDaddy Windows 启动器（macOS launcher 的 Windows 对应物，node 实现）
 *
 * 幂等三步：
 *   1) 确保 daemon 运行 —— watchdog 常驻（崩溃自动拉起）；daemon 版本与内置不一致时强制重启
 *   2) WorkBuddy 已在 CDP 模式（9222）→ 直接注入组件即完成
 *   3) 否则退出 WorkBuddy 并以 --remote-debugging-port=9222 重启 → 等端口 → 注入
 *
 * 由 launcher.cmd 调用（cmd 负责兜底找 node），也可 node win-launcher.js 直接运行。
 * 所有操作用户态完成（HKCU / %LOCALAPPDATA% / %APPDATA%），无需管理员权限。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const SCRIPTS_DIR = __dirname;
const DATA_DIR =
  process.env.WBSWITCH_DATA_DIR ||
  path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'WorkDaddy');
const UI_PORT_BASE = parseInt(process.env.WBSWITCH_PORT || '47832', 10);
const CDP_PORT = parseInt(process.env.WBSWITCH_CDP_PORT || '9222', 10);
let actualUiPort = UI_PORT_BASE;
const LAUNCHER_LOCK_FILE = path.join(DATA_DIR, 'launcher.pid');

function log(...args) {
  const line = `[launcher] ${new Date().toISOString()} ${args.join(' ')}\n`;
  try { process.stdout.write(line); } catch (_) {}
  try { fs.appendFileSync(path.join(DATA_DIR, 'launcher.log'), line); } catch (_) {}
}

// ---------- 小工具 ----------
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function pidAlive(pid) {
  if (!pid || pid === process.pid) return false;
  try {
    const r = spawnSync('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8', timeout: 5000, windowsHide: true,
    });
    return r.status === 0 && new RegExp('"' + pid + '"').test(r.stdout || '');
  } catch (_) { return false; }
}

function acquireLauncherLock() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(LAUNCHER_LOCK_FILE, String(process.pid), { flag: 'wx' });
      return true;
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      let oldPid = 0;
      try { oldPid = parseInt(fs.readFileSync(LAUNCHER_LOCK_FILE, 'utf8').trim(), 10); } catch (_) {}
      if (pidAlive(oldPid)) return false;
      try { fs.unlinkSync(LAUNCHER_LOCK_FILE); } catch (_) {}
    }
  }
  return false;
}

function releaseLauncherLock() {
  try {
    const owner = parseInt(fs.readFileSync(LAUNCHER_LOCK_FILE, 'utf8').trim(), 10);
    if (owner === process.pid) fs.unlinkSync(LAUNCHER_LOCK_FILE);
  } catch (_) {}
}

// 当前进程是否为管理员（Windows）
function isElevated() {
  try {
    const r = spawnSync(
      'net', ['session'], { stdio: 'ignore', windowsHide: true, timeout: 8000 }
    );
    return r.status === 0;
  } catch (_) { return false; }
}

// 以管理员身份运行"重启注入助手"（child 脚本），launcher 本体保持普通权限。
// 返回是否已成功派发（派发后 launcher 立即退出，由助手完成真正的重启+注入）。
function spawnElevatedHelper() {
  const nodeBin = process.execPath;                 // 当前 node
  const childJs = path.join(SCRIPTS_DIR, 'win-inject-helper.js');
  if (!fs.existsSync(childJs)) return false;
  const ps = [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-Command',
    'Start-Process -FilePath "' + nodeBin.replace(/"/g, '\\"') + '" ' +
      '-ArgumentList @("' + childJs.replace(/"/g, '\\"') + '","' + CDP_PORT + '") ' +
      '-Verb RunAs'
  ];
  try {
    spawnSync('powershell', ps, { stdio: 'ignore', windowsHide: true, timeout: 15000 });
    return true;
  } catch (_) { return false; }
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const t = setTimeout(() => { s.destroy(); resolve(false); }, 1200);
    s.on('connect', () => { clearTimeout(t); s.destroy(); resolve(true); });
    s.on('error', () => { clearTimeout(t); resolve(false); });
  });
}

function readApiToken() {
  try { return fs.readFileSync(path.join(DATA_DIR, 'api-token'), 'utf8').trim(); } catch (_) { return ''; }
}

function httpGet(port, p) {
  return new Promise((resolve) => {
    const token = readApiToken();
    const req = http.get({
      host: '127.0.0.1', port, path: p, timeout: 1500,
      headers: token ? { 'X-WorkDaddy-Token': token } : {},
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function httpPost(port, p) {
  return new Promise((resolve) => {
    const token = readApiToken();
    const req = http.request({
      host: '127.0.0.1', port, path: p, method: 'POST', timeout: 1500,
      headers: token ? { 'X-WorkDaddy-Token': token } : {},
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

function psOut(cmd) {
  try {
    return spawnSync('powershell', ['-NoProfile', '-Command', cmd], {
      encoding: 'utf8', timeout: 10000, windowsHide: true,
    }).stdout || '';
  } catch (_) { return ''; }
}

function readDaemonVersion() {
  try {
    const src = fs.readFileSync(path.join(SCRIPTS_DIR, 'daemon.js'), 'utf8');
    const m = src.match(/DAEMON_VERSION\s*=\s*'([^']+)'/);
    return m ? m[1] : '';
  } catch (_) { return ''; }
}

// ---------- 定位 node（托管优先：.workbuddy\binaries\node\versions\<v>\node.exe，其次 PATH） ----------
function findNode() {
  const base = path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'versions');
  let verDirs = [];
  try {
    verDirs = fs.readdirSync(base)
      .map((d) => path.join(base, d, 'node.exe'))
      .filter((p) => fs.existsSync(p))
      .sort();
  } catch (_) {}
  if (verDirs.length) return verDirs[verDirs.length - 1];
  try {
    const r = spawnSync('node', ['-v'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
    if (r.status === 0) return 'node';
  } catch (_) {}
  return null;
}

// ---------- 定位 WorkBuddy / WorkBuddyAI（环境变量 > 运行进程 > 注册表 > 常见路径） ----------
let wbBinaryCache = null;
function findWorkBuddy() {
  if (wbBinaryCache) return wbBinaryCache;
  const tryFile = (p) => { try { if (p && fs.existsSync(p)) return p; } catch (_) {} return null; };
  const envBin = tryFile(process.env.WBSWITCH_WORKBUDDY_BIN);
  if (envBin) return (wbBinaryCache = envBin);
  try {
    const p = psOut('Get-Process WorkBuddyAI,WorkBuddy -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path').split(/\r?\n/).filter(Boolean).pop();
    const hit = tryFile(p);
    if (hit) return (wbBinaryCache = hit);
  } catch (_) {}
  try {
    const p = psOut("$k=@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'); Get-ItemProperty $k -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'WorkBuddy|CodeBuddy' } | Select-Object -First 1 DisplayIcon,InstallLocation | ForEach-Object { if($_.DisplayIcon){ ($_.DisplayIcon -replace ',.*$','').Trim() } elseif($_.InstallLocation){ $ai=Join-Path $_.InstallLocation 'WorkBuddyAI.exe'; $legacy=Join-Path $_.InstallLocation 'WorkBuddy.exe'; if(Test-Path $ai){$ai}else{$legacy} } }").split(/\r?\n/).filter(Boolean).pop();
    const hit = tryFile(p);
    if (hit) return (wbBinaryCache = hit);
  } catch (_) {}
  for (const c of [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'WorkBuddyAI', 'WorkBuddyAI.exe'),
    path.join(process.env.ProgramFiles || '', 'WorkBuddyAI', 'WorkBuddyAI.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'WorkBuddyAI', 'WorkBuddyAI.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'WorkBuddy', 'WorkBuddy.exe'),
    path.join(process.env.ProgramFiles || '', 'WorkBuddy', 'WorkBuddy.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'WorkBuddy', 'WorkBuddy.exe'),
    'D:\\workbody\\WorkBuddy\\WorkBuddy.exe',
  ]) {
    const hit = tryFile(c);
    if (hit) return (wbBinaryCache = hit);
  }
  return null;
}

// ---------- 1. 确保 daemon 运行 ----------
function watchdogAlive() {
  try {
    const pid = parseInt(fs.readFileSync(path.join(DATA_DIR, 'watchdog.pid'), 'utf8').trim(), 10);
    if (!pid) return false;
    const r = spawnSync('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    return r.status === 0 && /node/i.test(r.stdout);
  } catch (_) { return false; }
}

async function findDaemonPort() {
  for (let port = UI_PORT_BASE; port < UI_PORT_BASE + 8; port++) {
    const st = await httpGet(port, '/api/status');
    if (st && st.status === 200) {
      try {
        const parsed = JSON.parse(st.body);
        if (parsed && parsed.ok === true && typeof parsed.version === 'string') {
          actualUiPort = port;
          return { port, status: st, parsed };
        }
      } catch (_) {}
    }
  }
  return null;
}

async function daemonRunning() {
  return !!(await findDaemonPort());
}

async function ensureDaemon(nodeBin) {
  fs.mkdirSync(path.join(DATA_DIR, 'accounts'), { recursive: true });
  // 已有 daemon：检查版本一致性（旧版本代码继续注入会出兼容问题）
  const found = await findDaemonPort();
  if (found) {
    const runningVer = found.parsed.version || '';
    const want = readDaemonVersion();
    if (runningVer === want) {
      log('daemon 已在运行且版本一致 (' + runningVer + ', port=' + actualUiPort + ')，跳过启动');
      return true;
    }
    log('检测到旧版 daemon (' + runningVer + ' != ' + want + ')，强制重启');
    stopDaemonByPort(actualUiPort);
  } else if (watchdogAlive()) {
    log('watchdog 在运行但 daemon 未就绪，等待其拉起...');
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      if (await daemonRunning()) { log('daemon 已就绪 (port=' + actualUiPort + ')'); return true; }
    }
    log('等待超时，主动拉起 watchdog');
  }
  // 启动 watchdog（它负责启动 daemon + 崩溃拉起）。
  // WBSWITCH_HEAL_COLD_START：launcher 托管的会话里 WorkBuddy 就该处于 CDP 模式，
  // 允许 daemon 冷启动自愈（WorkBuddy 在跑但从未连上调试端口时也能修复）
  if (!watchdogAlive()) {
    log('启动 watchdog: ' + nodeBin);
    const child = spawn(nodeBin, [path.join(SCRIPTS_DIR, 'watchdog.js')], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: Object.assign({}, process.env, { WBSWITCH_HEAL_COLD_START: '1' }),
    });
    child.unref();
  }
  for (let i = 0; i < 30; i++) {
    await sleep(400);
    if (await daemonRunning()) { log('daemon 已就绪 (port=' + actualUiPort + ')'); return true; }
  }
  log('等待 daemon 就绪超时');
  return await daemonRunning();
}

function stopDaemonByPort(port = actualUiPort) {
  // 杀 watchdog（会连带杀 daemon）→ 兜底按端口杀
  try {
    const pid = parseInt(fs.readFileSync(path.join(DATA_DIR, 'watchdog.pid'), 'utf8').trim(), 10);
    if (pid) spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    try { fs.unlinkSync(path.join(DATA_DIR, 'watchdog.pid')); } catch (_) {}
  } catch (_) {}
  // 兜底：杀监听 UI 端口的进程
  const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 8000, windowsHide: true }).stdout || '';
  const lines = out.split(/\r?\n/).filter((l) => l.includes(':' + port) && /LISTENING/i.test(l));
  const pids = new Set();
  for (const l of lines) {
    const m = l.trim().split(/\s+/);
    const pid = m[m.length - 1];
    if (pid && /^\d+$/.test(pid)) pids.add(pid);
  }
  for (const pid of pids) {
    spawnSync('taskkill', ['/F', '/T', '/PID', pid], { stdio: 'ignore', windowsHide: true });
  }
  return pids.size > 0;
}

// ---------- 2/3. WorkBuddy CDP 处理 ----------
function quitWorkBuddy(wb) {
  return new Promise((resolve) => {
    const imageName = path.basename(wb || '') || 'WorkBuddy.exe';
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    const run = (args) => {
      const p = spawn('taskkill', args, { stdio: 'ignore', windowsHide: true });
      p.on('error', finish);
      p.on('exit', () => setTimeout(finish, 700));
    };
    run(['/IM', imageName]);
    setTimeout(() => { if (!done) run(['/F', '/T', '/IM', imageName]); }, 2500);
    setTimeout(finish, 8000);
  });
}

async function injectNow() {
  const r = await httpPost(actualUiPort, '/api/inject');
  return !!(r && r.status >= 200 && r.status < 300);
}

// ---------- main ----------
(async () => {
  if (!acquireLauncherLock()) {
    log('已有 launcher 实例在运行，本次启动跳过');
    process.exit(0);
  }
  process.on('exit', releaseLauncherLock);

  const nodeBin = findNode();
  if (!nodeBin) {
    log('未找到 Node.js（需 .workbuddy\\binaries 托管 node 或 PATH 中的 node）');
    console.error('错误：未找到 Node.js。请先安装 Node.js 或安装 WorkBuddy（自带托管 node）。');
    process.exit(1);
  }

  const daemonReady = await ensureDaemon(nodeBin);
  if (!daemonReady) {
    console.error('WorkDaddy daemon 启动失败。日志：' + path.join(DATA_DIR, 'launcher.log'));
    process.exit(5);
  }

  // 已在 CDP 模式 → 幂等注入
  if (await portOpen(CDP_PORT)) {
    const injected = await injectNow();
    if (!injected) {
      log('WorkBuddy 已在调试模式，但 /api/inject 调用失败');
      process.exit(6);
    }
    log('WorkBuddy 已在调试模式（端口 ' + CDP_PORT + '），组件已注入');
    console.log('WorkDaddy：WorkBuddy 已在调试模式，组件已注入 ✓');
    process.exit(0);
  }

  // 未开 CDP → 需要重启 WorkBuddy 带调试端口
  const wb = findWorkBuddy();
  if (!wb) {
    console.error('未找到 WorkBuddy/WorkBuddyAI 可执行文件。可用环境变量 WBSWITCH_WORKBUDDY_BIN 指定完整路径。');
    log('未找到 WorkBuddy/WorkBuddyAI 可执行文件');
    process.exit(2);
  }

  // 先按当前用户权限直接重启。只有真实失败时才请求一次 UAC，避免日常启动无意义弹窗。
  log('重启 WorkBuddy（带 --remote-debugging-port=' + CDP_PORT + '）: ' + wb);
  console.log('正在以调试模式重启 WorkBuddy（约几秒）...');

  await quitWorkBuddy(wb);
  await sleep(500);
  const child = spawn(wb, ['--remote-debugging-port=' + CDP_PORT], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', (e) => { log('启动 WorkBuddy 失败: ' + e.message); });
  child.unref();

  let ok = false;
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    if (await portOpen(CDP_PORT)) { ok = true; break; }
  }
  if (ok) {
    await sleep(1500);
    const injected = await injectNow();
    if (!injected) {
      log('WorkBuddy CDP 已启动，但 /api/inject 调用失败');
      process.exit(6);
    }
    log('WorkBuddy 已启动（调试模式），组件已注入');
    console.log('WorkDaddy：WorkBuddy 已启动（调试模式），组件已注入 ✓');
    process.exit(0);
  }

  log('等待 20 秒未检测到调试端口 ' + CDP_PORT);
  if (!isElevated() && !process.argv.includes('--inject-helper')) {
    log('普通权限重启未成功，尝试请求 UAC 兜底');
    if (spawnElevatedHelper()) process.exit(0);
  }
  console.log('等待超时：未检测到调试端口 ' + CDP_PORT + '。可手动执行：cd /d ' + path.dirname(wb) + ' && "' + wb + '" --remote-debugging-port=' + CDP_PORT);
  process.exit(3);
})().catch((e) => {
  log('launcher 异常: ' + (e && e.stack || e));
  console.error('WorkDaddy 启动异常: ' + (e && e.message || e));
  process.exit(4);
});
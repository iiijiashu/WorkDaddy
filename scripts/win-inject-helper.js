#!/usr/bin/env node
/**
 * WorkDaddy 提权注入助手（win-launcher.js 的成人版重跑）
 *
 * 背景：WorkBuddy 常装在 C:\Program Files（受 UAC 保护的特权目录）。
 * 若旧 WorkBuddy 进程本身已提升，结束它需要管理员权限；WorkBuddy 新 GUI 进程仍保持用户权限。
 * 普通权限启动 launcher 时无法完成这一步（表现为黑屏空转、9222 起不来）。
 *
 * 本助手由 win-launcher.js 通过 Start-Process -Verb RunAs 以管理员身份拉起：
 *   1) 转交系统里真实的 win-launcher.js 继续执行（此时进程已是管理员）
 *   2) launcher 以管理员权限结束旧进程/接管 daemon，再通过 ShellExecute 以用户权限启动 WorkBuddy
 *
 * 用法(仅内部)：
 *   node win-inject-helper.js [cdpPort]
 *   通常由 launcher 派发，无需用户直接运行。
 */
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

// 复用同一份 main 逻辑：以管理员身份重跑 win-launcher.js
// 传参 --inject-helper 会让 win-launcher 知道"正在提权流程中，别二次派发"，避免死循环。
const LAUNCHER = path.join(__dirname, 'win-launcher.js');

// 校验当前确实是管理员
let elevated = false;
try {
  elevated = spawnSync('net', ['session'], { stdio: 'ignore', windowsHide: true, timeout: 8000 }).status === 0;
} catch (_) {}

if (!elevated) {
  console.error('错误：win-inject-helper 必须以管理员身份运行。');
  process.exit(2);
}

// Windows 下重新分配一个真正的控制台窗口过于复杂；直接静默继续
// （launcher 会负责日志与提示）。把它作为子进程跑完。
const cdpPort = process.argv.slice(2).find((arg) => /^\d+$/.test(arg));
const args = ['--inject-helper'];
if (cdpPort) args.push('--cdp-port=' + cdpPort);
const cp = spawnSync(process.execPath, [LAUNCHER, ...args], {
  stdio: 'inherit',
  windowsHide: true,
  timeout: 90000,
});

process.exit(cp.status === null ? 1 : cp.status);

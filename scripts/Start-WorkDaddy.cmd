@echo off
chcp 65001 >nul
rem ============================================================
rem  WorkDaddy 一键启动（zip 解压后的顶层入口，双击运行）
rem  作用：确保守护进程运行 + 以调试模式拉起/重启 WorkBuddy + 注入组件。
rem        已在安装后日常只需双击桌面「WorkDaddy」图标。
rem  设计：绝对路径定位 scripts\launcher.cmd，无相对路径歧义。
rem ============================================================
setlocal
if not exist "%~dp0scripts\launcher.cmd" (
  echo 错误：找不到 %~dp0scripts\launcher.cmd，请确认在解压后的 zip 根目录运行。
  pause
  exit /b 1
)
call "%~dp0scripts\launcher.cmd" --interactive

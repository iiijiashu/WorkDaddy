@echo off
chcp 65001 >nul
rem WorkDaddy Windows 启动器（诊断入口；日常启动由 launch-hidden.vbs 静默调用）
rem 需要：launcher.cmd 与 win-launcher.js / watchdog.js / daemon.js 在同一目录
setlocal
cd /d "%~dp0"

rem 定位 node：优先 WorkBuddy 托管运行时（.workbuddy\binaries\node\versions\*），其次 PATH
set "NODE="
for /d %%d in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do (
  if exist "%%d\node.exe" set "NODE=%%d\node.exe"
)
if not defined NODE set "NODE=node"

if not exist "%~dp0win-launcher.js" (
  echo 错误：找不到 win-launcher.js，请勿单独运行本文件。
  exit /b 1
)

"%NODE%" --experimental-sqlite "%~dp0win-launcher.js" %*
set "EXIT_CODE=%ERRORLEVEL%"

if /I "%~1"=="--interactive" (
  echo.
  if "%EXIT_CODE%"=="0" (
    echo 完成：WorkDaddy 组件已就绪，WorkBuddy 右下角应有机器人按钮。
  ) else (
    echo 未完全完成（代码 %EXIT_CODE%）。日志：%APPDATA%\WorkDaddy\launcher.log
  )
  pause
)
exit /b %EXIT_CODE%
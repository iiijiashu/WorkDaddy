@echo off
chcp 65001 >nul
rem WorkDaddy Windows 安装核心（由 Install-WorkDaddy.cmd 或安装目录调用）
rem 仅用 %~dp0 绝对路径定位 install-win.ps1，杜绝 scripts\scripts 嵌套导致的相对路径歧义
setlocal

where powershell >nul 2>nul
if errorlevel 1 (
  echo 错误：未找到 PowerShell（Windows 10/11 均自带）。
  pause
  exit /b 1
)

if not exist "%~dp0install-win.ps1" (
  echo 错误：找不到 scripts\install-win.ps1（请确认与 install-win.cmd 同目录）。
  pause
  exit /b 3
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-win.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if "%EXIT_CODE%"=="0" (
  echo 安装完成。WorkBuddy 即将以调试模式重启，请稍等片刻。
) else (
  echo 安装过程有异常（代码 %EXIT_CODE%），请查看上方输出。
)
pause

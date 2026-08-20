# WorkDaddy Windows 安装脚本（install.sh 的 Windows 对应物）
# 用法：双击 install-win.cmd，或 powershell -ExecutionPolicy Bypass -File install-win.ps1
# 作用：复制到安装目录 → 初始化数据目录 → 注册登录自启(HKCU Run) → 启动 launcher（自动拉起 daemon + 以 CDP 模式重启 WorkBuddy）
# 全程用户态，无需管理员权限。
param(
  [string]$SrcDir = $PSScriptRoot,
  [string]$AppDir = (Join-Path $env:LOCALAPPDATA 'Programs\WorkDaddy')
)

$ErrorActionPreference = 'Continue'
$targetScripts = Join-Path $AppDir 'scripts'
$dataDir = Join-Path $env:APPDATA 'WorkDaddy'

Write-Host '=============================================================='
Write-Host ' WorkDaddy Windows 安装'
Write-Host '=============================================================='
Write-Host ("  源目录   : " + $SrcDir)
Write-Host ("  安装目录 : " + $AppDir)

# 1) 覆盖升级前先停止旧 WorkDaddy 进程，避免 launcher.cmd 被旧交互窗口长期占用。
try {
  $pidFile = Join-Path $dataDir 'watchdog.pid'
  if (Test-Path $pidFile) {
    $wpid = [int]((Get-Content $pidFile -Raw).Trim())
    if ($wpid -gt 0) { taskkill /F /T /PID $wpid 2>$null | Out-Null }
  }
} catch {}
try {
  $oldLauncher = (Join-Path $targetScripts 'launcher.cmd').ToLowerInvariant()
  Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($oldLauncher) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
} catch {}
Start-Sleep -Milliseconds 500

# 2) 镜像复制（排除开发/临时文件；node_modules/ws 随包带入）。
#    安装目录由 WorkDaddy 独占管理，使用 /MIR 可清理旧版本残留文件，避免混跑旧脚本。
if (-not (Test-Path (Join-Path $SrcDir 'daemon.js'))) {
  Write-Host '错误：源目录中找不到 daemon.js，请从仓库 scripts/ 目录运行本脚本。'
  exit 1
}
New-Item -ItemType Directory -Force -Path $targetScripts | Out-Null
robocopy $SrcDir $targetScripts /MIR /R:3 /W:1 /XF *.log .DS_Store /XD win\probe
$rc = $LASTEXITCODE
if ($rc -ge 8) {
  Write-Host "复制失败（robocopy=$rc）"
  exit 2
}

# 3) 数据目录
New-Item -ItemType Directory -Force -Path (Join-Path $dataDir 'accounts') | Out-Null

# 3.5) Logo 图标：随安装复制到安装目录根（桌面快捷方式用），源在 scripts 同级的 WorkDaddy.ico
$logoIcoSrc = Join-Path $SrcDir 'WorkDaddy.ico'
$logoIco = Join-Path $AppDir 'WorkDaddy.ico'
if (Test-Path $logoIcoSrc) {
  try { Copy-Item $logoIcoSrc $logoIco -Force; Write-Host ('  图标复制 : ' + $logoIco) } catch {}
}

# 4) 创建/迁移静默入口（桌面快捷方式 + HKCU Run）
$launcher = Join-Path $targetScripts 'launcher.cmd'
$hiddenLauncher = Join-Path $targetScripts 'launch-hidden.vbs'
$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
$repairEntrypoints = Join-Path $targetScripts 'repair-entrypoints.ps1'
try {
  if (-not (Test-Path $repairEntrypoints)) { throw 'repair-entrypoints.ps1 不存在' }
  & $repairEntrypoints -AppDir $AppDir
} catch {
  Write-Host ('  静默入口创建失败（可忽略，可手动运行 launcher.cmd --interactive）: ' + $_.Exception.Message)
}

# 5) 启动（daemon + 以 CDP 模式重启 WorkBuddy + 注入）
Write-Host '  正在启动 WorkDaddy（如果 WorkBuddy 正在运行，会重启它以开启调试模式）...'
if (Test-Path $hiddenLauncher) {
  Start-Process -FilePath $wscript -ArgumentList @('//B', '//Nologo', $hiddenLauncher) -WindowStyle Hidden
} else {
  Write-Host '  警告：launch-hidden.vbs 不存在，跳过自动启动（可手动运行 launcher.cmd --interactive）'
}

Write-Host '=============================================================='
Write-Host ' 安装完成！'
Write-Host ("  安装目录 : " + $AppDir)
Write-Host ("  数据目录 : " + $dataDir)
Write-Host ('  备份账号 : ' + (Join-Path $dataDir 'accounts'))
Write-Host '  卸载     : 运行安装目录 scripts\uninstall-win.ps1'
Write-Host '=============================================================='
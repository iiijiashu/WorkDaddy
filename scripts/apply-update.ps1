# WorkDaddy Windows 自动更新替换脚本（apply-update.sh 的 Windows 对应物）
# 由 daemon.js applyUpdate() 调用，参数：
#   $1 更新包 zip 路径（update 目录里下载好的 WorkDaddy-<ver>.zip）
#   $2 安装目录（默认 %LOCALAPPDATA%\Programs\WorkDaddy）
#   $3 本地 API 端口（等待旧 daemon 退出用，默认 47832）
# 流程：等端口释放 → 杀 watchdog/daemon → 备份旧目录(.old 可回滚) → 解压替换 → 拉起
# 注意：Windows 运行中的 exe/js 有文件锁，必须先杀进程再替换。
param(
  [Parameter(Mandatory = $true)][string]$SrcZip,
  [string]$AppDir = (Join-Path $env:LOCALAPPDATA 'Programs\WorkDaddy'),
  [string]$Port = '47832'
)

$ErrorActionPreference = 'Continue'
$DataDir = Join-Path $env:APPDATA 'WorkDaddy'
$LogDir = Join-Path $DataDir 'update'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Log = Join-Path $LogDir 'apply.log'
Start-Transcript -Path $Log -Append -Force

Write-Host "[apply] $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') start src=$SrcZip dst=$AppDir"

# 1) 杀 watchdog（会连带终止 daemon；PID 文件在数据目录）
$pidFile = Join-Path $DataDir 'watchdog.pid'
if (Test-Path $pidFile) {
  try {
    $wpid = [int]((Get-Content $pidFile -Raw).Trim())
    if ($wpid -gt 0) { taskkill /F /T /PID $wpid 2>$null | Out-Null }
  } catch {}
}

# 1.5) 清理旧版 launcher.cmd 的交互窗口；1.0.4 末尾 pause 会长期持有脚本文件。
try {
  $oldLauncher = (Join-Path $AppDir 'scripts\launcher.cmd').ToLowerInvariant()
  Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($oldLauncher) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
} catch {}

# 2) 兜底：按 API 端口杀残留进程
$waitSec = 0
while ($waitSec -lt 30) {
  $listening = netstat -ano | Select-String (":$Port\s") | Select-String 'LISTENING'
  if (-not $listening) { break }
  # 尝试优雅等待
  Start-Sleep -Seconds 1
  $waitSec++
}
foreach ($line in (netstat -ano | Select-String (":$Port\s") | Select-String 'LISTENING')) {
  $parts = ($line.ToString().Trim() -split '\s+')
  $pid2 = $parts[$parts.Count - 1]
  if ($pid2 -match '^\d+$') { taskkill /F /T /PID $pid2 2>$null | Out-Null }
}
Start-Sleep -Seconds 1

# 3) 备份旧目录（回滚：move AppDir.old AppDir）
$oldDir = $AppDir + '.old'
if (Test-Path $oldDir) { Remove-Item -Recurse -Force $oldDir -ErrorAction SilentlyContinue }
if (Test-Path $AppDir) { Move-Item -Force $AppDir $oldDir -ErrorAction SilentlyContinue }

# 4) 解压新版到临时目录，再移动到位（Expand-Archive 无法原地覆盖已存在目录）
$tmpDir = Join-Path $env:TEMP ("workdaddy-update-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
try {
  Expand-Archive -Path $SrcZip -DestinationPath $tmpDir -Force
} catch {
  Write-Host "[apply] 解压失败: $($_.Exception.Message)"
  if (Test-Path $oldDir) { Move-Item -Force $oldDir $AppDir -ErrorAction SilentlyContinue }  # 回滚
  Stop-Transcript
  exit 1
}

# 定位 zip 内的应用根：顶层含 scripts\daemon.js（打包结构）→ 顶层即根；个别情况顶层直接是文件
$srcRoot = $tmpDir
if (-not (Test-Path (Join-Path $tmpDir 'scripts\daemon.js')) -and -not (Test-Path (Join-Path $tmpDir 'daemon.js'))) {
  $hit = Get-ChildItem $tmpDir -Recurse -Filter 'daemon.js' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($hit) { $srcRoot = Split-Path $hit.FullName -Parent }
}
New-Item -ItemType Directory -Force -Path $AppDir | Out-Null

# 复制内容（robocopy /MIR 保留结构；失败则回滚）
$rc = 1
robocopy $srcRoot $AppDir /MIR /NFL /NDL /NJH /NJS /NP
$rc = $LASTEXITCODE  # robocopy 0-7 都算成功
if ($rc -ge 8) {
  Write-Host "[apply] 复制失败(robocopy=$rc)，回滚旧版本"
  Remove-Item -Recurse -Force $AppDir -ErrorAction SilentlyContinue
  if (Test-Path $oldDir) { Move-Item -Force $oldDir $AppDir }
  Stop-Transcript
  exit 2
}

# 5) 清理备份 + 静默拉起（release zip 的 launcher 位于 scripts\）
Remove-Item -Recurse -Force $oldDir -ErrorAction SilentlyContinue
$hiddenLauncher = Join-Path $AppDir 'scripts\launch-hidden.vbs'
$launcher = Join-Path $AppDir 'scripts\launcher.cmd'
$repairEntrypoints = Join-Path $AppDir 'scripts\repair-entrypoints.ps1'
$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
if (Test-Path $repairEntrypoints) {
  try { & $repairEntrypoints -AppDir $AppDir } catch { Write-Host ('[apply] 修复静默入口失败: ' + $_.Exception.Message) }
}
if (Test-Path $hiddenLauncher) {
  Start-Process -FilePath $wscript -ArgumentList @('//B', '//Nologo', $hiddenLauncher) -WindowStyle Hidden
} elseif (Test-Path $launcher) {
  Start-Process -FilePath $launcher -WorkingDirectory (Split-Path $launcher) -WindowStyle Hidden
}
Write-Host "[apply] $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') done"
Stop-Transcript
exit 0
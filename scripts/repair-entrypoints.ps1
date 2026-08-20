# 修复/迁移 Windows 日常入口：桌面快捷方式 + HKCU Run 均指向静默 VBS 启动器。
param(
  [string]$AppDir = (Split-Path $PSScriptRoot -Parent)
)

$ErrorActionPreference = 'Stop'
$targetScripts = $PSScriptRoot
$hiddenLauncher = Join-Path $targetScripts 'launch-hidden.vbs'
$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'

if (-not (Test-Path $hiddenLauncher)) { throw 'launch-hidden.vbs 不存在' }
if (-not (Test-Path $wscript)) { throw 'wscript.exe 不存在' }

$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runValue = '"' + $wscript + '" //B //Nologo "' + $hiddenLauncher + '"'
Set-ItemProperty -Path $runKey -Name 'WorkDaddy' -Value $runValue

$desktopDir = [Environment]::GetFolderPath('Desktop')
if (-not $desktopDir) { $desktopDir = Join-Path $env:USERPROFILE 'Desktop' }
$lnkPath = Join-Path $desktopDir 'WorkDaddy.lnk'
$logoIco = Join-Path $targetScripts 'WorkDaddy.ico'

$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnkPath)
$sc.TargetPath = $wscript
$sc.Arguments = '//B //Nologo "' + $hiddenLauncher + '"'
$sc.WorkingDirectory = $targetScripts
$sc.Description = 'WorkDaddy – WorkBuddy 增强工具（静默启动）'
if (Test-Path $logoIco) { $sc.IconLocation = $logoIco + ',0' }
$sc.Save()

Write-Host ('  自启入口     : ' + $runValue)
Write-Host ('  桌面快捷方式 : ' + $lnkPath)

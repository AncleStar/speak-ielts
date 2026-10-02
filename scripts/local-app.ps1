param(
  [ValidateSet('Start','Status','Restart','Stop')][string]$Action = 'Start',
  [switch]$NoBrowser,
  [switch]$NoWait
)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runDirectory = Join-Path $projectRoot 'data\run'
$stateFile = Join-Path $runDirectory 'supervisor.json'
New-Item -ItemType Directory -Path $runDirectory -Force | Out-Null
function Read-AppState {
  if (Test-Path -LiteralPath $stateFile) {
    try { return Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
  }
  return $null
}
function Get-OwnedProcess($state) {
  if (-not $state -or $state.root -ne $projectRoot -or $state.instance -notmatch '^[a-zA-Z0-9_-]+$') { return $null }
  $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$state.pid)" -ErrorAction SilentlyContinue
  if ($candidate -and $candidate.CommandLine -and $candidate.CommandLine.Contains('scripts/dev-all.ts') -and $candidate.CommandLine.Contains("--instance=$($state.instance)")) { return $candidate }
  return $null
}
function Show-AppStatus {
  $state = Read-AppState
  if (-not (Get-OwnedProcess $state)) {
    Write-Host '应用管理进程未运行。双击“启动应用”即可启动。'
    if ($state -and $state.status -eq 'failed') { Write-Host $state.message }
    return
  }
  Write-Host ("状态：{0}" -f $state.message)
  Write-Host ("地址：{0}/login" -f $state.url)
  Write-Host ("运行编号：{0}" -f $state.pid)
  try {
    $health = Invoke-RestMethod -Uri ($state.url + '/api/health') -TimeoutSec 4
    if ($health.ok -and $health.app -eq 'ielts-speaking') { Write-Host '网页、数据库和后台处理在线。' }
    else { Write-Host '服务尚未全部就绪，请稍后查看状态或重启应用。' }
  } catch { Write-Host '尚未通过健康检查；构建中请等待，持续异常可查看日志。' }
  Write-Host ("日志：{0}" -f (Join-Path $runDirectory 'app.err.log'))
}
if ($Action -eq 'Status') { Show-AppStatus; exit 0 }
$hasher = [Security.Cryptography.SHA256]::Create()
$digest = [BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($projectRoot))).Replace('-','')
$hasher.Dispose()
$mutex = New-Object Threading.Mutex($false, ('Local\SpeakApp-' + $digest.Substring(0,24)))
$locked = $false
try {
  try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
  if (-not $locked) { Write-Host '另一个启动或停止操作正在进行，请稍后查看状态。'; exit 0 }
  if ($Action -in @('Stop','Restart')) {
    $state = Read-AppState
    if (Get-OwnedProcess $state) {
      $stopFile = Join-Path $runDirectory ('stop-' + $state.instance)
      [IO.File]::WriteAllText($stopFile, 'stop')
      Write-Host '正在停止本应用的网页与后台处理，保存数据不受影响…'
      $deadline = (Get-Date).AddSeconds(45)
      while ((Get-OwnedProcess $state) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
      if (Get-OwnedProcess $state) { throw '停止超时，未强制结束其他进程。请检查日志后再试。' }
    } else { Write-Host '没有本入口管理的运行进程。' }
    if ($Action -eq 'Stop') { Show-AppStatus; exit 0 }
  }
  $state = Read-AppState
  if (Get-OwnedProcess $state) { Show-AppStatus; if (-not $NoBrowser -and $state.status -eq 'ready') { Start-Process ($state.url + '/login') }; exit 0 }
  $nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
  $instance = [Guid]::NewGuid().ToString()
  # Rotate small diagnostic logs once per manual start; no user recordings are touched.
  foreach ($name in @('app.out.log','app.err.log')) {
    $currentLog = Join-Path $runDirectory $name
    if (Test-Path -LiteralPath $currentLog) { Copy-Item -LiteralPath $currentLog -Destination ($currentLog + '.previous') -Force }
  }
  $child = Start-Process -FilePath $nodeExecutable -ArgumentList @('--import','tsx','scripts/dev-all.ts','--production',('--instance=' + $instance)) -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runDirectory 'app.out.log') -RedirectStandardError (Join-Path $runDirectory 'app.err.log') -PassThru
  Write-Host '应用正在后台启动。关闭这个提示窗口不会停止练习服务。'
  Write-Host '如代码有更新，会先自动构建；可双击“查看应用状态”检查进度。'
  if ($NoWait) { exit 0 }
  $deadline = (Get-Date).AddMinutes(4)
  $previousMessage = ''
  while ((Get-Date) -lt $deadline) {
    $state = Read-AppState
    if ($state -and $state.instance -eq $instance) {
      if ($state.message -ne $previousMessage) { Write-Host $state.message; $previousMessage = $state.message }
      if ($state.status -eq 'ready') { Show-AppStatus; if (-not $NoBrowser) { Start-Process ($state.url + '/login') }; exit 0 }
      if ($state.status -eq 'failed') { throw ($state.message + '；请查看 data\run\app.err.log') }
    }
    $child.Refresh()
    if ($child.HasExited) { throw '启动进程已退出，请查看 data\run\app.err.log。若已有终端启动应用，请勿重复启动。' }
    Start-Sleep -Seconds 1
  }
  Write-Host '启动仍在进行，未强制停止。请稍后双击“查看应用状态”。'
} finally { if ($locked) { $mutex.ReleaseMutex() }; $mutex.Dispose() }

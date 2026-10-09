param(
  [ValidateSet('start','stop')][string]$Action = 'start',
  [ValidateSet('observatory','mobilework','doubao','mobilework-stack','all')][string]$Component = 'observatory'
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$node = (Get-Command node.exe -ErrorAction Stop).Source
$settingsJson = & $node (Join-Path $PSScriptRoot 'paths.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Cannot load project configuration.' }
$settings = $settingsJson | ConvertFrom-Json
$runtime = $settings.runtime
$processDir = Join-Path $runtime 'processes'
$logDir = Join-Path $runtime 'logs'
New-Item -ItemType Directory -Force -Path $processDir,$logDir | Out-Null
$entries = @{
  observatory = @{ Script = (Join-Path $root 'server.mjs'); Port = $settings.port }
  mobilework = @{ Script = (Join-Path $root 'collectors\mobilework-llm-proxy\index.mjs'); Port = 8890 }
  doubao = @{ Script = (Join-Path $root 'collectors\doubao-cdp-collector\index.mjs'); Port = 0 }
}
function Get-OwnedProcess($record, $script) {
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($record.pid)" -ErrorAction Stop
  if ($proc -and $proc.ExecutablePath -eq $record.executable -and $proc.CommandLine.Contains('"' + $script + '"')) { return $proc }
  return $null
}
function Invoke-Service([string]$name) {
  $entry = $entries[$name]
  $recordFile = Join-Path $processDir ($name + '.json')
  $owned = $null
  if (Test-Path -LiteralPath $recordFile) {
    $record = Get-Content -LiteralPath $recordFile -Raw | ConvertFrom-Json
    $owned = Get-OwnedProcess $record $entry.Script
  }
  if ($Action -eq 'stop') {
    if ($owned) { Stop-Process -Id $owned.ProcessId -ErrorAction Stop; Write-Host "Stopped project service: $name" }
    else { Write-Host "No managed project process to stop: $name (other processes untouched)." }
    if (Test-Path -LiteralPath $recordFile) { Remove-Item -LiteralPath $recordFile }
    return
  }
  if ($owned) { Write-Host "Already running: $name"; return }
  if ($entry.Port) {
    $client = New-Object Net.Sockets.TcpClient
    try { $client.Connect('127.0.0.1', [int]$entry.Port); throw "Port $($entry.Port) is in use; no existing process will be killed. Stop it manually or change the project port." }
    catch [Net.Sockets.SocketException] { }
    finally { $client.Dispose() }
  }
  $process = Start-Process -FilePath $node -ArgumentList ('"' + $entry.Script + '"') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir ($name + '.out.log')) -RedirectStandardError (Join-Path $logDir ($name + '.err.log')) -PassThru
  Start-Sleep -Milliseconds 750
  if ($process.HasExited) { throw "Service $name exited; see runtime/logs/$name.err.log" }
  @{ pid = $process.Id; executable = $node; script = $entry.Script } | ConvertTo-Json | Set-Content -LiteralPath $recordFile -Encoding UTF8
  Write-Host "Started: $name (PID $($process.Id)); logs: $logDir"
}
if ($Component -eq 'all') {
  if ($Action -eq 'stop') {
    foreach ($n in @('observatory','mobilework','doubao')) { Invoke-Service $n }
    Write-Host 'All managed project services stopped. Agent clients (Mobilework/Doubao) are never terminated by this script.'
    return
  }
  # start：主服务必须成功；采集器尽力而为（缺前置条件时跳过并提示，不视为失败）
  Invoke-Service 'observatory'
  try { Invoke-Service 'mobilework' }
  catch { Write-Host "WARN mobilework proxy not started: $($_.Exception.Message)" }
  $cdpPort = 9223
  if ($env:DOUBAO_CDP_PORT) { $cdpPort = [int]$env:DOUBAO_CDP_PORT }
  $tcp = New-Object Net.Sockets.TcpClient
  $cdpOk = $false
  try { $tcp.Connect('127.0.0.1', $cdpPort); $cdpOk = $true }
  catch { }
  finally { $tcp.Dispose() }
  if ($cdpOk) {
    try { Invoke-Service 'doubao' }
    catch { Write-Host "WARN doubao collector not started: $($_.Exception.Message)" }
  } else {
    Write-Host "skip doubao collector: CDP port $cdpPort not listening (launch Doubao with --remote-debugging-port=$cdpPort to enable TTFT capture)."
  }
} elseif ($Component -eq 'mobilework-stack') {
  if ($Action -eq 'start') {
    if (!$settings.mobilework -or !(Test-Path -LiteralPath $settings.mobilework -PathType Leaf)) { throw 'Set agents.mobilework.installDir or AGENT_LOG_MOBILEWORK_EXE first.' }
    $proxyConfig = Join-Path $runtime 'mobilework-proxy.json'
    if ($env:AGENT_LOG_PROXY_CONFIG) { $proxyConfig = $env:AGENT_LOG_PROXY_CONFIG }
    if (Test-Path -LiteralPath $proxyConfig) {
      $proxy = Get-Content -LiteralPath $proxyConfig -Raw | ConvertFrom-Json
      if ($proxy.port -and $proxy.port -ne 8890) { throw 'The stack launcher expects proxy port 8890. Start the proxy/client manually for custom ports.' }
    }
    Invoke-Service 'mobilework'
    Invoke-Service 'observatory'
    $oldProxy = $env:HTTP_PROXY; $oldNoProxy = $env:NO_PROXY
    try {
      $env:HTTP_PROXY = 'http://127.0.0.1:8890'; $env:NO_PROXY = '127.0.0.1,localhost,::1'
      Start-Process -FilePath $settings.mobilework -WorkingDirectory (Split-Path $settings.mobilework) | Out-Null
    } finally { $env:HTTP_PROXY = $oldProxy; $env:NO_PROXY = $oldNoProxy }
    Write-Host 'Mobilework launched. Close an already-running client BEFORE starting if it did not inherit HTTP_PROXY.'
  } else {
    Write-Host 'Close Mobilework yourself first; this script never terminates Agent clients.'
    Invoke-Service 'mobilework'; Invoke-Service 'observatory'
  }
} else { Invoke-Service $Component }

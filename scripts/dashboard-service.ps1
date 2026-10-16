# Run the dashboard (npm run dashboard) as a background service on Windows: a scheduled task that
# starts at boot, runs without a window and restarts after a crash. Registering needs an elevated shell.
#   powershell -ExecutionPolicy Bypass -File scripts\dashboard-service.ps1 install|uninstall|status|restart
param([ValidateSet("install", "uninstall", "status", "restart")][string]$Action = "status")

$ErrorActionPreference = "Stop"
$TaskName = "CodexDelegateDashboard"
$Root = Split-Path -Parent $PSScriptRoot
$Port = if ($env:CODEX_DELEGATE_DASHBOARD_PORT) { $env:CODEX_DELEGATE_DASHBOARD_PORT } else { "4318" }
$LogDir = Join-Path $env:USERPROFILE ".codex-delegate"
$Log = Join-Path $LogDir "dashboard.log"

function Show-Status {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $task) { "task: not installed"; return }
  "task: $($task.State)"
  try {
    $r = Invoke-WebRequest "http://127.0.0.1:$Port/api/runs" -UseBasicParsing -TimeoutSec 3
    "http: $($r.StatusCode) http://127.0.0.1:$Port"
  } catch { "http: not responding on port $Port (log: $Log)" }
}

# Stopping the task ends only cmd; node would live on. Kill the loop first so it can't respawn node.
function Stop-Dashboard {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  $script = Join-Path $Root "src\dashboard.ts"
  foreach ($name in "cmd.exe", "node.exe") {
    Get-CimInstance Win32_Process -Filter "Name='$name'" | Where-Object { $_.CommandLine -like "*$script*" } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  }
}

switch ($Action) {
  "install" {
    $node = (Get-Command node -ErrorAction Stop).Source
    Stop-Dashboard
    New-Item -ItemType Directory -Force $LogDir | Out-Null
    # Task Scheduler's restart policy only covers failures to start, not a process that exits later,
    # so cmd loops: node exits → wait 5s (ping; `timeout` needs a console) → start again.
    $run = "`"$node`" `"$Root\src\dashboard.ts`" >> `"$Log`" 2>&1"
    $cmd = "/c for /l %i in (0,0,1) do ($run & ping -n 6 127.0.0.1 >nul)"
    $taskAction = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\cmd.exe" -Argument $cmd -WorkingDirectory $Root
    $triggers = @((New-ScheduledTaskTrigger -AtStartup), (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME))
    # S4U: runs as this user without a stored password and without a visible window.
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
      -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $triggers -Principal $principal -Settings $settings `
      -Description "Codex delegate dashboard on http://127.0.0.1:$Port (read-only, localhost only)" -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 3
    Show-Status
  }
  "restart" {
    Stop-Dashboard
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 3
    Show-Status
  }
  "uninstall" {
    Stop-Dashboard
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    "removed $TaskName"
  }
  "status" { Show-Status }
}

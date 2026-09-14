# Guest-side helper for the "Start VM worker" button.
#
# Run inside the Windows VM by the Mac through UTM's guest agent
# (`utmctl exec ... powershell -File Z:\worker\vm_task.ps1 <action>`). The
# guest agent runs us as SYSTEM in session 0, where nothing can touch the
# desktop, so the worker itself is started through a scheduled task that is
# bound to the interactive user (logon type "Interactive" = runs in the
# user's session, with a visible console window). Results are written to
# C:\Windows\Temp\rpa_vm_result.json (pulled with `utmctl file pull`) and to
# Z:\worker\vm_result.json, because utmctl does not reliably return output.
#
#   status    -> who is logged on, does the task exist, is the worker running
#   register  -> create/refresh the task "RPAWorker" (at logon + on demand)
#   start     -> register if needed, then start the task
#   stop      -> stop the task and kill the worker / RASAero processes
#   probe     -> network view from the guest: can it reach the Mac's SMB port, what drives are mapped
param(
    [string]$Action = "status",
    [string]$TaskName = "RPAWorker",
    [string]$Share = "Z:",
    [string]$Python = "auto",
    [string]$Nonce = "",
    [string]$Out = "C:\Windows\Temp\rpa_vm_result.json",
    [string]$Transport = "share",      # share: run Z:\worker\run_worker.py ; agent: run the copy the Mac pushed to <Root>\worker
    [string]$Root = "C:\rpa",
    [string]$MacHost = "192.168.64.1"  # the Mac, as seen from the VM (probe)
)
$ErrorActionPreference = "Continue"
$result = [ordered]@{ action = $Action; nonce = $Nonce; ok = $false; time = (Get-Date).ToString("s"); host = $env:COMPUTERNAME; agent_user = $env:USERNAME }

function Interactive-User {
    try { (Get-CimInstance Win32_ComputerSystem).UserName } catch { $null }
}
function Worker-Processes {
    try {
        Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($_.CommandLine -match "run_worker\.py|rasaero_worker\.py") } | ForEach-Object { @{ pid = $_.ProcessId; cmd = $_.CommandLine } }
    } catch { @() }
}
function Task-State {
    try { (Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop).State.ToString() } catch { "missing" }
}
function Find-Python($user) {
    # the interactive user's python.org install, else whatever 'python' resolves to in their session
    if ($Python -ne "auto") { return $Python }
    $name = ($user -split "\\")[-1]
    $candidates = @()
    foreach ($root in @("C:\Users\$name\AppData\Local\Programs\Python", "C:\Program Files", "C:\Program Files (x86)")) {
        if (Test-Path $root) { $candidates += Get-ChildItem -Path $root -Directory -Filter "Python3*" -ErrorAction SilentlyContinue | ForEach-Object { Join-Path $_.FullName "python.exe" } }
    }
    $found = $candidates | Where-Object { Test-Path $_ } | Sort-Object -Descending | Select-Object -First 1
    if ($found) { return '"' + $found + '"' }
    return "python"
}
function Register-Worker-Task {
    $user = Interactive-User
    if (-not $user) { throw "nobody is logged on to Windows - log in (or enable auto-login) first" }
    $py = Find-Python $user
    $script:pythonUsed = $py
    if ($Transport -eq "agent") {
        $cmd = "$py $Root\worker\run_worker.py --jobs $Root\jobs --repo $Root --transport agent"
    } else {
        $cmd = "$py $Share\worker\run_worker.py"
    }
    $script:commandUsed = $cmd
    $action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument ("/c title RPA worker && " + $cmd)
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan)
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    # an older name for the same task must not linger: two logon tasks would start two workers
    foreach ($old in @("RPA Worker")) { if ($old -ne $TaskName) { Unregister-ScheduledTask -TaskName $old -Confirm:$false -ErrorAction SilentlyContinue } }
    return $user
}

try {
    switch ($Action) {
        "status" {
            $result.user = Interactive-User
            $result.task = Task-State
            $result.workers = @(Worker-Processes)
            $result.ok = $true
        }
        "register" {
            $result.user = Register-Worker-Task
            $result.python = $script:pythonUsed
            $result.command = $script:commandUsed
            $result.task = Task-State
            $result.ok = $true
        }
        "start" {
            $running = @(Worker-Processes)
            if ($running.Count -gt 0) {
                $result.message = "worker already running (pid " + ($running | ForEach-Object { $_.pid }) -join "," + ")"
            } else {
                $result.user = Register-Worker-Task   # (re)register every time so the task follows the config
                $result.python = $script:pythonUsed
                $result.command = $script:commandUsed
                Start-ScheduledTask -TaskName $TaskName
                Start-Sleep -Seconds 3
                $result.workers = @(Worker-Processes)
                $result.message = "task started"
            }
            $result.task = Task-State
            $result.ok = $true
        }
        "stop" {
            try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}
            $killed = @()
            foreach ($p in @(Worker-Processes)) { try { Stop-Process -Id $p.pid -Force -ErrorAction SilentlyContinue; $killed += $p.pid } catch {} }
            foreach ($p in @(Get-Process -Name "RASAero II" -ErrorAction SilentlyContinue)) { try { $p.Kill(); $killed += $p.Id } catch {} }
            $result.killed = $killed
            $result.task = Task-State
            $result.ok = $true
        }
        "probe" {
            $result.smb_port_open = $false
            try { $result.smb_port_open = (Test-NetConnection -ComputerName $MacHost -Port 445 -WarningAction SilentlyContinue -InformationLevel Quiet) } catch { $result.smb_error = $_.Exception.Message }
            try { $result.mappings = @(Get-SmbMapping -ErrorAction SilentlyContinue | ForEach-Object { @{ local = $_.LocalPath; remote = $_.RemotePath; status = $_.Status.ToString() } }) } catch { $result.mappings = @() }
            try { $result.net_use = (cmd /c "net use 2>&1") -join "`n" } catch {}
            try { $result.drives = @(Get-PSDrive -PSProvider FileSystem | ForEach-Object { @{ name = $_.Name; root = $_.Root; display = $_.DisplayRoot } }) } catch {}
            $result.ok = $true
        }
        default { throw "unknown action $Action" }
    }
} catch {
    $result.error = $_.Exception.Message
}
$json = $result | ConvertTo-Json -Depth 4 -Compress
# base64 so `utmctl file pull` cannot mangle it; local copy first (no WebDAV caching), then the share as a fallback
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
foreach ($path in @($Out, (Join-Path $Share "worker\vm_result.b64"))) {
    for ($i = 0; $i -lt 5; $i++) {
        try { [System.IO.File]::WriteAllText($path, $b64); break } catch { Start-Sleep -Seconds 1 }
    }
}
Write-Output $json

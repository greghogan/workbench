[CmdletBinding(DefaultParameterSetName='Install')]
param(
    [Parameter(Mandatory, ParameterSetName='Install')][string] $Node,
    [Parameter(Mandatory, ParameterSetName='Install')][string] $Archive,
    [Parameter(Mandatory, ParameterSetName='Install')][ValidatePattern('^[a-fA-F0-9]{64}$')][string] $Digest,
    [Parameter(Mandatory, ParameterSetName='Install')][switch] $RebootDisposableGuest,
    [Parameter(Mandatory, ParameterSetName='Observe')][ValidateSet('startup','user-install')][string] $Phase,
    [switch] $SerialLog
)

$stage = if ($PSCmdlet.ParameterSetName -eq 'Install') { 'prepare' } else { $Phase }
$ErrorActionPreference = 'Stop'
$Root = Join-Path $env:ProgramFiles 'WorkbenchBootFixture'
$Service = 'WorkbenchApplication'
$Observer = 'WorkbenchBootFixtureObserver'
$SystemPort = 37947
$UserPort = 37948
$UserName = 'wbdesktop'
$Winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
$Pwsh = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$NodePath = "$Root\node.exe"
$ArchivePath = "$Root\workbench.tar.gz"
$DigestPath = "$Root\SHA256SUMS"
$External = "$Root\workbench\bin\workbench.mjs"
$SystemLauncher = "$Root\installed\workbench.cjs"
$DesktopConfig = "$Root\desktop.json"
$Marker = "$Root\phase.txt"

function Report([string] $Message) {
    $Message = "WB-TEST $Message"
    Add-Content -LiteralPath "$Root\qualification.log" -Encoding ASCII -Value $Message
    Write-Host $Message
    if ($SerialLog) {
        $serial = [IO.Ports.SerialPort]::new('COM1',115200,[IO.Ports.Parity]::None,8,[IO.Ports.StopBits]::One)
        $serial.WriteTimeout = 3000
        try { $serial.Open(); $serial.WriteLine($Message) } finally { $serial.Dispose() }
    }
}
function Invoke-Workbench([string[]] $Arguments) {
    & $NodePath @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Workbench exited with status $LASTEXITCODE." }
}
function Install-Workbench([string] $Path) {
    $checksum = (Get-Content -LiteralPath $DigestPath -Raw).Trim()
    Invoke-Workbench @($External,'install','--archive',$ArchivePath,'--sha256',$checksum,'--directory',$Path) | Out-Null
}
function BootTime { return (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime() }
function Clear-AutoLogon {
    Set-ItemProperty -LiteralPath $Winlogon -Name AutoAdminLogon -Value '0'
    Remove-ItemProperty -LiteralPath $Winlogon -Name DefaultPassword -ErrorAction SilentlyContinue
    Remove-ItemProperty -LiteralPath $Winlogon -Name AutoLogonCount -ErrorAction SilentlyContinue
}
function BrowserStatus([int] $Port) {
    $request = [Net.HttpWebRequest]::Create("http://127.0.0.1:$Port/projects")
    $request.Timeout = 1500
    $request.AllowAutoRedirect = $false
    $request.Proxy = $null
    try { $response = $request.GetResponse() }
    catch [Net.WebException] { $response = $_.Exception.Response; if (!$response) { return 0 } }
    try { return [int]$response.StatusCode } finally { $response.Dispose() }
}
function Wait-Until([string] $Label, [int] $Seconds, [scriptblock] $Predicate) {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        if (& $Predicate) { return }
        Start-Sleep -Milliseconds 750
    } while ($timer.Elapsed.TotalSeconds -lt $Seconds)
    throw "Timed out waiting for $Label."
}

if ($stage -eq 'prepare') {
    $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if (!$RebootDisposableGuest -or
        !$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -or
        (Get-Service -Name $Service -ErrorAction SilentlyContinue) -or
        (Get-ScheduledTask -TaskName $Observer -ErrorAction SilentlyContinue) -or
        (Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue) -or
        (Test-Path -LiteralPath $Root)) {
        throw 'Use a clean disposable Windows guest with administrative access. This check reboots it twice.'
    }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $Archive).Hash -ne $Digest) {
        throw 'The candidate archive checksum differs from its verified record.'
    }
    New-Item -Path $Root -ItemType Directory | Out-Null
    Copy-Item -LiteralPath $Node -Destination $NodePath
    Copy-Item -LiteralPath $Archive -Destination $ArchivePath
    Copy-Item -LiteralPath $PSCommandPath -Destination "$Root\verify.ps1"
    $Digest.ToLowerInvariant() | Set-Content -LiteralPath $DigestPath -Encoding ASCII
    & icacls.exe $Root /setowner '*S-1-5-32-544' /T /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not set fixture ownership.' }
    & icacls.exe $Root /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not protect the fixture directory.' }
} elseif ($PSCommandPath -ne "$Root\verify.ps1") {
    throw 'Use the initially installed fixture for the observer phases.'
}
$serialArgument = if ($SerialLog) { ' -SerialLog' } else { '' }
Set-Location -LiteralPath $Root

try {
    switch ($stage) {
        'prepare' {
            Report "Desktop Experience setup finished. Windows $([Environment]::OSVersion.Version) boot $((BootTime).ToString("o"))."
            Clear-AutoLogon
            & tar.exe -xzf $ArchivePath -C $Root
            if ($LASTEXITCODE -ne 0) { throw 'Archive extraction failed.' }
            Install-Workbench "$Root\installed"
            Invoke-Workbench @($SystemLauncher,'install','--service','system','--port',[string]$SystemPort) | Out-Null
            $registration = Get-Service -Name $Service
            if ($registration.StartType -ne 'Automatic' -or $registration.Status -ne 'Stopped') {
                throw 'Expected a stopped automatic SCM registration before the first reboot.'
            }

            $password = 'Az9!' + [guid]::NewGuid().ToString('N')
            $secure = ConvertTo-SecureString $password -AsPlainText -Force
            $user = New-LocalUser -Name $UserName -Password $secure -PasswordNeverExpires
            $users = Get-LocalGroup -SID 'S-1-5-32-545'
            if (-not (Get-LocalGroupMember -Group $users | Where-Object SID -eq $user.SID)) {
                Add-LocalGroupMember -Group $users -Member $user
            }
            $logon = [PSCredential]::new("$env:COMPUTERNAME\$UserName",$secure)
            try {
                $userInstall = @{
                    FilePath = $Pwsh
                    ArgumentList = "-NoProfile -ExecutionPolicy Bypass -File ""$Root\verify.ps1"" -Phase user-install"
                    Credential = $logon
                    WorkingDirectory = $Root
                }
                $installer = Start-Process @userInstall -LoadUserProfile -PassThru -Wait
                if ($installer.ExitCode -ne 0) { throw "Per-user installation exited $($installer.ExitCode)." }
            } finally {
                $secure.Dispose()
            }
            $taskName = "Workbench.Private.$($user.SID.Value)"
            $scheduled = Get-ScheduledTask -TaskName $taskName -TaskPath '\'
            if ($scheduled.State -ne 'Ready' -or $scheduled.Principal.LogonType -ne 'Interactive' -or $scheduled.Principal.RunLevel -ne 'Limited') {
                throw 'Expected an unstarted interactive logon task under the ordinary account.'
            }
            $previousLogon = (Get-ScheduledTaskInfo -TaskName $taskName -TaskPath '\').LastRunTime
            $profile = (Get-CimInstance Win32_UserProfile -Filter "SID = '$($user.SID.Value)'").LocalPath
            if (!$profile) { throw 'The ordinary account has no loaded Windows profile.' }
            [pscustomobject]@{ sid=$user.SID.Value; task=$taskName; profile=$profile; password=$password; originalBoot=(BootTime).ToString('o'); priorTaskRun=$previousLogon.ToString('o') } |
                ConvertTo-Json | Set-Content -LiteralPath $DesktopConfig
            & icacls.exe $DesktopConfig /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' /Q | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'Could not restrict the fixture password file.' }

            $observe = "-NoProfile -ExecutionPolicy Bypass -File ""$Root\verify.ps1"" -Phase startup$serialArgument"
            $action = New-ScheduledTaskAction -Execute $Pwsh -Argument $observe
            $trigger = New-ScheduledTaskTrigger -AtStartup
            $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
            'system' | Set-Content -LiteralPath $Marker
            Register-ScheduledTask -TaskName $Observer -Action $action -Trigger $trigger -Principal $principal | Out-Null
            Report 'Both Workbench registrations are installed and stopped. Rebooting for the SCM boot check.'
            Restart-Computer -Force
        }
        'user-install' {
            try {
                $destination = Join-Path $env:LOCALAPPDATA WorkbenchBootInstalled
                Install-Workbench $destination
                Invoke-Workbench @("$destination\workbench.cjs",'install','--service','user','--port',[string]$UserPort) | Out-Null
            } catch {
                [IO.File]::WriteAllText("$env:TEMP\workbench-user-install-error.txt", ($_ | Out-String))
                exit 1
            }
        }
        'startup' {
            $which = (Get-Content -LiteralPath $Marker -Raw).Trim()
            $cfg = Get-Content -LiteralPath $DesktopConfig -Raw | ConvertFrom-Json
            $boot = BootTime
            if ($which -eq 'system') {
                if ($boot -le [DateTime]::Parse($cfg.originalBoot).ToUniversalTime()) { throw 'The Windows kernel did not reboot.' }
                Wait-Until 'SCM to start the shared listener automatically' 90 {
                    (Get-Service -Name $Service).Status -eq 'Running' -and (BrowserStatus $SystemPort) -eq 401
                }
                if (@(Get-CimInstance Win32_Process -Filter "Name = 'explorer.exe' AND SessionId > 0").Count) {
                    throw 'A desktop session was present during the independent SCM boot check.'
                }
                $scm = Get-CimInstance Win32_Service -Filter "Name = '$Service'"
                if ($scm.ProcessId -le 0 -or $scm.StartName -ne 'LocalSystem') { throw 'Unexpected SCM process or identity.' }
                Report "PASS SCM automatically started the authenticated listener before desktop sign-in (boot $($boot.ToString('o')), service PID $($scm.ProcessId))."
                Stop-Service -Name $Service
                Invoke-Workbench @($SystemLauncher,'uninstall','--service','system') | Out-Null
                Set-ItemProperty -LiteralPath $Winlogon -Name AutoAdminLogon -Value '1'
                Set-ItemProperty -LiteralPath $Winlogon -Name DefaultDomainName -Value $env:COMPUTERNAME
                Set-ItemProperty -LiteralPath $Winlogon -Name DefaultUserName -Value $UserName
                Set-ItemProperty -LiteralPath $Winlogon -Name DefaultPassword -Value $cfg.password
                New-ItemProperty -LiteralPath $Winlogon -Name AutoLogonCount -PropertyType DWord -Value 1 -Force | Out-Null
                $cfg.originalBoot = $boot.ToString('o')
                $cfg.password = $null
                $cfg | ConvertTo-Json | Set-Content -LiteralPath $DesktopConfig
                'user' | Set-Content -LiteralPath $Marker
                Report 'Removed the system registration. Rebooting for a fresh ordinary-user desktop sign-in.'
                Restart-Computer -Force
            } elseif ($which -eq 'user') {
                if ($boot -le [DateTime]::Parse($cfg.originalBoot).ToUniversalTime()) { throw 'The Windows kernel did not restart for the logon check.' }
                Wait-Until 'the ordinary desktop session and its Workbench listener' 120 {
                    (Get-ScheduledTask -TaskName $cfg.task -TaskPath '\').State -eq 'Running' -and
                    (BrowserStatus $UserPort) -eq 401
                }
                $last = (Get-ScheduledTaskInfo -TaskName $cfg.task -TaskPath '\').LastRunTime.ToUniversalTime()
                if ($last -lt $boot -or $last -le [DateTime]::Parse($cfg.priorTaskRun).ToUniversalTime()) {
                    throw 'The user task did not start during this boot.'
                }
                $endpoint = @(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $UserPort -State Listen)
                if ($endpoint.Count -ne 1) { throw 'Expected one private listener.' }
                $listener = Get-CimInstance Win32_Process -Filter "ProcessId = $($endpoint[0].OwningProcess)"
                $owner = (Invoke-CimMethod -InputObject $listener -MethodName GetOwnerSid).Sid
                $explorer = @(Get-CimInstance Win32_Process -Filter "Name = 'explorer.exe' AND SessionId > 0" | Where-Object {
                    $_.SessionId -eq $listener.SessionId -and
                    (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid).Sid -eq $cfg.sid
                })
                if ($owner -ne $cfg.sid -or !$explorer.Count) { throw 'The listener does not belong to the new ordinary desktop session.' }
                Clear-AutoLogon
                Report "PASS Task Scheduler automatically started the authenticated private listener in the new ordinary-user desktop (session $($listener.SessionId), listener PID $($listener.ProcessId), run $($last.ToString('o')))."
                Disable-ScheduledTask -TaskName $Observer | Out-Null
                Report 'PASS BOTH WINDOWS STARTUP CHECKS'
            } else { throw "Unrecognized startup phase $which." }
        }
    }
} catch {
    if ($stage -eq 'user-install') { exit 1 }
    $reason = "$($_.InvocationInfo.ScriptLineNumber): $($_.Exception.Message)" -replace '[\r\n]+',' '
    Clear-AutoLogon
    Report "FAIL $stage $reason"
    throw
}

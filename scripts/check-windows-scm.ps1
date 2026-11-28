param(
    [Parameter(Mandatory)][string] $Helper,
    [Parameter(Mandatory)][string] $Node
)

$ErrorActionPreference = 'Stop'
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run the SCM qualification as an administrator on a disposable Windows host.'
}

$suffix = [guid]::NewGuid().ToString('N').Substring(0, 10)
$service = "WorkbenchControlTest-$suffix"
$root = Join-Path $env:ProgramFiles $service
$executable = Join-Path $root workbench-scm.exe
$nodeExe = Join-Path $root node.exe
$worker = Join-Path $root worker.mjs
$unsafe = Join-Path $root unsafe.mjs
$accounts = @()
$credentials = @()
$registered = $false
$created = $false
$workerProcesses = @()

function Test-Native($Name, [ScriptBlock] $Command) {
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "$Name failed with exit status $LASTEXITCODE." }
}

function Register-Fixture([string] $Entrypoint) {
    New-Service -Name $service -StartupType Manual -BinaryPathName (
        '"{0}" service {1} "{2}" "{3}"' -f $executable, $service, $nodeExe, $Entrypoint
    ) | Out-Null
    $script:registered = $true
}

function Remove-Fixture {
    if (-not $script:registered) { return }
    if ((Get-Service -Name $service).Status -ne 'Stopped') { Stop-Service -Name $service }
    (Get-Service -Name $service).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(20))
    Test-Native 'Service removal' { sc.exe delete $service }
    $script:registered = $false
}

function Request-Worker([PSCredential] $Credential) {
    $start = [Diagnostics.ProcessStartInfo]::new($executable, "launch $service")
    $start.Domain = $env:COMPUTERNAME
    $start.UserName = $Credential.UserName
    $start.Password = $Credential.Password
    $start.LoadUserProfile = $true
    $start.WorkingDirectory = $root
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw 'Could not launch the ordinary-account request.' }
        $output = $process.StandardOutput.ReadToEndAsync()
        $diagnostic = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(15000)) {
            $process.Kill()
            $process.WaitForExit()
            throw 'The ordinary-account request did not finish.'
        }
        if ($process.ExitCode -ne 0) {
            throw "Worker launch failed with status $($process.ExitCode). $($diagnostic.GetAwaiter().GetResult())"
        }
        $value = $output.GetAwaiter().GetResult() | ConvertFrom-Json
        if ($value.pid -le 0) { throw 'Missing worker process identity.' }
        return $value.pid
    } finally {
        $process.Dispose()
    }
}

function Wait-Worker([string] $Sid, [int] $WorkerPid) {
    $directory = Join-Path $root $Sid
    $ready = Join-Path $directory ready.json
    $failure = Join-Path $directory failure.txt
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while (-not (Test-Path -LiteralPath $ready)) {
        if (Test-Path -LiteralPath $failure) {
            throw "Worker fixture failed: $(Get-Content -LiteralPath $failure -Raw)"
        }
        if (-not (Get-Process -Id $WorkerPid -ErrorAction SilentlyContinue)) {
            throw 'The SCM worker exited before publishing the account and profile checks.'
        }
        if ($timer.Elapsed.TotalSeconds -ge 15) {
            throw 'The SCM worker remained alive without publishing the account and profile checks.'
        }
        Start-Sleep -Milliseconds 100
    }
    $observed = Get-Content -LiteralPath $ready -Raw | ConvertFrom-Json
    if ($observed.pid -ne $WorkerPid -or $observed.child -le 0) { throw 'Worker identity did not match its reply.' }
    return @((Get-Process -Id $WorkerPid), (Get-Process -Id $observed.child))
}

try {
    New-Item -ItemType Directory -Path $root | Out-Null
    $created = $true
    Copy-Item -LiteralPath (Resolve-Path -LiteralPath $Helper).ProviderPath -Destination $executable
    Copy-Item -LiteralPath (Resolve-Path -LiteralPath $Node).ProviderPath -Destination $nodeExe
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot ../app/test/integration/distribution/windows-worker-fixture.mjs) -Destination $worker
    Copy-Item -LiteralPath $worker -Destination $unsafe
    Test-Native 'Set fixture owner' { icacls.exe $root /setowner '*S-1-5-32-544' /T /Q }
    Test-Native 'Set fixture permissions' {
        icacls.exe $root /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' /Q
    }
    Test-Native 'Make the rejected entry point writable' { icacls.exe $unsafe /grant:r '*S-1-5-32-545:W' /Q }
    Register-Fixture $unsafe
    $rejected = $false
    try { Start-Service -Name $service } catch { $rejected = $true }
    $rejectedService = Get-CimInstance Win32_Service -Filter "Name = '$service'"
    if (-not $rejected -or $rejectedService.State -ne 'Stopped' -or $rejectedService.ExitCode -ne 5) {
        throw 'The SCM host accepted a user-writable entry point.'
    }
    Remove-Fixture
    $service += '-valid'

    $group = Get-LocalGroup -SID ([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'))
    foreach ($index in 1, 2) {
        $name = "wb$suffix$index"
        $password = ConvertTo-SecureString -String ('Aa1!' + [guid]::NewGuid().ToString('N')) -AsPlainText -Force
        $user = New-LocalUser -Name $name -Password $password
        $sid = $user.SID.Value
        $accounts += @{name = $name; sid = $sid}
        $credentials += [PSCredential]::new($name, $password)
        if (-not (Get-LocalGroupMember -Group $group | Where-Object { $_.SID -eq $user.SID })) {
            Add-LocalGroupMember -Group $group -Member $user
        }
        $personal = Join-Path $root $sid
        New-Item -ItemType Directory -Path $personal | Out-Null
        Test-Native 'Set account fixture permissions' {
            icacls.exe $personal /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "*${sid}:(OI)(CI)M" /Q
        }
        [IO.File]::WriteAllText((Join-Path $personal marker), $name)
    }
    [IO.File]::WriteAllText((Join-Path $root accounts.json), (ConvertTo-Json -InputObject $accounts -Compress))

    Register-Fixture $worker
    New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\$service" -Name Environment `
        -PropertyType MultiString -Value @('WORKBENCH_SERVICE_FIXTURE=1') | Out-Null
    Start-Service -Name $service
    (Get-Service -Name $service).WaitForStatus('Running', [TimeSpan]::FromSeconds(15))
    for ($index = 0; $index -lt $accounts.Count; $index++) {
        $workerPid = Request-Worker $credentials[$index]
        $workerProcesses += Wait-Worker $accounts[$index].sid $workerPid
        if ((Request-Worker $credentials[$index]) -ne $workerPid) { throw 'The account started a duplicate worker.' }
    }
    if (@($workerProcesses.Id | Sort-Object -Unique).Count -ne 4) { throw 'Workers from two accounts shared a process.' }
    Stop-Service -Name $service
    (Get-Service -Name $service).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(20))
    foreach ($process in $workerProcesses) {
        if (-not $process.WaitForExit(5000)) { throw 'The worker job retained a process after SCM shutdown.' }
    }
    Write-Output 'SCM verified two account profiles, guarded file access, worker reuse, and worker-tree shutdown.'
} finally {
    $cleanup = @()
    try { Remove-Fixture } catch { $cleanup += $_ }
    foreach ($process in $workerProcesses) { $process.Dispose() }
    foreach ($account in $accounts) {
        try {
            Remove-LocalUser -Name $account.name
            $profile = Get-CimInstance Win32_UserProfile -Filter "SID = '$($account.sid)'"
            if ($profile -and $profile.Loaded) { throw 'A fixture account profile stayed loaded after shutdown.' }
            if ($profile) { Remove-CimInstance -InputObject $profile }
        } catch { $cleanup += $_ }
    }
    try { if ($created) { Remove-Item -LiteralPath $root -Force -Recurse } } catch { $cleanup += $_ }
    foreach ($issue in $cleanup) { Write-Error -ErrorRecord $issue -ErrorAction Continue }
    if ($cleanup.Count) { throw 'SCM fixture cleanup was incomplete.' }
}

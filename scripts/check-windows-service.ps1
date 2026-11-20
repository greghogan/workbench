param(
    [Parameter(Mandatory)][string] $Node,
    [Parameter(Mandatory)][string] $Archive,
    [Parameter(Mandatory)][string] $Digest,
    [ValidateRange(1024, 49151)][int] $Port = 37947,
    [string] $Replacement,
    [string] $ReplacementDigest,
    [switch] $ResumeWorker,
    [switch] $IdleWorkers,
    [switch] $PrivateService,
    [switch] $Handoff,
    [switch] $Recovery,
    [switch] $DesktopTask
)

$ErrorActionPreference = 'Stop'
$service = 'WorkbenchApplication'
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -or
    (Get-Service -Name $service -ErrorAction SilentlyContinue)) {
    throw 'Use a disposable administrator-capable Windows host without an installed Workbench service.'
}
if ($Digest -notmatch '^[a-f0-9]{64}$' -or [bool]$Replacement -ne [bool]$ReplacementDigest) {
    throw 'Supply the exact candidate checksum and both replacement inputs when exercising upgrades.'
}
$Archive = (Resolve-Path -LiteralPath $Archive).ProviderPath
if ((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Digest) {
    throw 'The candidate archive checksum differs from its verified record.'
}
if ($Replacement) {
    $Replacement = (Resolve-Path -LiteralPath $Replacement).ProviderPath
    if ($ReplacementDigest -notmatch '^[a-f0-9]{64}$' -or $ReplacementDigest -eq $Digest -or
        (Get-FileHash -LiteralPath $Replacement -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ReplacementDigest) {
        throw 'Supply a distinct replacement archive with a matching checksum.'
    }
}
$suffix = [guid]::NewGuid().ToString('N').Substring(0, 10)
$root = Join-Path $env:ProgramFiles "WorkbenchServiceTest-$suffix"
$nodeExe = Join-Path $root node.exe
$external = Join-Path $root workbench/bin/workbench.mjs
$launcher = Join-Path $root installed/workbench.cjs
$accounts = @()
$origin = ([Uri]"http://127.0.0.1:$port/").GetLeftPart([UriPartial]::Authority)
$systemProfile = Get-ItemPropertyValue -LiteralPath (
    'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\S-1-5-18'
) -Name ProfileImagePath
$serviceLogs = Join-Path ([Environment]::ExpandEnvironmentVariables($systemProfile)) 'AppData/Local/workbench/state/logs/server'
$previousLogs = @(Get-ChildItem -LiteralPath $serviceLogs -Directory -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty FullName)
$created = $false
$registered = $false
$desktopAccount = $null
$desktopSession = 0
$client = [Net.Http.HttpClient]::new()
$client.Timeout = [TimeSpan]::FromSeconds(20)

function Invoke-Checked($Label, [ScriptBlock] $Command) {
    $response = & $Command
    if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE." }
    return $response
}

function Workbench([string[]] $Arguments) {
    Invoke-Checked 'Installed Workbench' { & $nodeExe $launcher @Arguments }
}

function Start-FixtureNode([string[]] $Arguments, $Account) {
    $start = [Diagnostics.ProcessStartInfo]::new($nodeExe)
    foreach ($part in $Arguments) { $start.ArgumentList.Add($part) }
    if ($Account) { $start.WorkingDirectory = $Account.project }
    if ($Account.password) {
        $start.Domain = $env:COMPUTERNAME
        $start.UserName = $Account.name
        $start.Password = $Account.password
        $start.LoadUserProfile = $true
    }
    $start.UseShellExecute = $false
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.CreateNoWindow = $true
    $process = [Diagnostics.Process]::Start($start)
    if (-not $process) { throw 'Could not start the fixture command.' }
    return @{ process = $process; output = $process.StandardOutput.ReadToEndAsync(); errors = $process.StandardError.ReadToEndAsync() }
}

function Close-FixtureNode($Running) {
    try {
        if (-not $Running.process.HasExited) {
            $Running.process.Kill($true)
            if (-not $Running.process.WaitForExit(10000)) { throw 'The fixture command remained running.' }
        }
    } finally { $Running.process.Dispose() }
}

function Read-FixtureOutput($Running) {
    if (-not $Running.process.WaitForExit(60000)) { throw 'The fixture command did not finish.' }
    if (-not $Running.output.Wait(10000) -or -not $Running.errors.Wait(10000)) {
        throw 'The fixture command exited with its output still open.'
    }
    if ($Running.process.ExitCode -ne 0) {
        $diagnostic = $Running.errors.GetAwaiter().GetResult() -replace '(?m)(Sign-in password: ).*', '$1[redacted]'
        throw "Fixture command failed. $diagnostic"
    }
    return $Running.output.GetAwaiter().GetResult()
}

function Invoke-FixtureNode([string[]] $Arguments, $Account) {
    $running = Start-FixtureNode $Arguments $Account
    try { return Read-FixtureOutput $running } finally { Close-FixtureNode $running }
}

function Invoke-AccountNode($Account, [string[]] $Arguments) {
    return Invoke-FixtureNode $Arguments $Account
}

function Invoke-Account($Account, [string[]] $Arguments) {
    Invoke-AccountNode $Account (@($Account.launcher ?? $launcher) + $Arguments)
}

function Assert-PortOwnership([bool] $Protected) {
    $probe = @'
const {createServer} = require('node:net');
const [host, port, protectedOrigin] = process.argv.slice(1);
const server = createServer();
const expected = protectedOrigin === 'true';
server.once('error', (error) => {
  if (!expected || !['EACCES', 'EADDRINUSE'].includes(error.code)) throw error;
});
server.listen({host, port: Number(port), exclusive: true}, () => {
  server.close();
  if (expected) throw new Error('An ordinary account claimed the installed service port');
});
'@
    foreach ($account in $accounts) {
        foreach ($address in '127.0.0.1', '0.0.0.0', '::') {
            Invoke-AccountNode $account @('-e', $probe, $address, [string]$port,
                $Protected.ToString().ToLowerInvariant()) | Out-Null
        }
    }
}

function Sign-In($Account, [string[]] $Arguments = @('serve')) {
    return Read-SignIn $Account (Invoke-Account $Account $Arguments)
}

function Read-SignIn($Account, [string] $text) {
    $url = [regex]::Match($text, '(?m)^Workbench web UI: ([^\r\n]+)').Groups[1].Value
    $user = [regex]::Match($text, '(?m)^Sign-in username: ([^\r\n]+)').Groups[1].Value
    $secret = [regex]::Match($text, '(?m)^Sign-in password: ([A-Za-z0-9_-]{43})').Groups[1].Value
    if ($url -ne $origin -or $user -ne $Account.name -or -not $secret) {
        throw 'The real installed CLI did not report the expected shared listener and account.'
    }
    return [Net.Http.Headers.AuthenticationHeaderValue]::new(
        'Basic', [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("${user}:$secret"))
    )
}

function Browse($Authentication, [string] $Path, [string] $Method = 'GET', [string] $WebOrigin = $origin) {
    $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::new($Method), "$WebOrigin$Path")
    if ($Authentication) { $request.Headers.Authorization = $Authentication }
    if ($Method -eq 'POST') { $request.Headers.Add('Origin', $WebOrigin) }
    try {
        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        try {
            return @{
                status = [int]$response.StatusCode
                body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            }
        } finally {
            $response.Dispose()
        }
    } finally {
        $request.Dispose()
    }
}

function Wait-Service([string] $State) {
    $item = Get-Service -Name $service
    try { $item.WaitForStatus($State, [TimeSpan]::FromSeconds(60)) } finally { $item.Dispose() }
    if ($State -ne 'Running') { return }
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while ((Service-Readiness) -ne 'running') {
        if ((Get-Service -Name $service).Status -eq 'Stopped' -or $timer.Elapsed.TotalSeconds -ge 60) {
            throw 'The running SCM supervisor did not publish browser readiness.'
        }
        Start-Sleep -Milliseconds 200
    }
}

function Service-Readiness {
    $helper = Join-Path (Split-Path -Parent $launcher) '.workbench-installation/workbench-scm.exe'
    $status = Invoke-Checked 'Inspect Workbench browser readiness' { & $helper status $service } | ConvertFrom-Json
    return $status.state
}

function Assert-ActiveRelease([string] $Expected) {
    $selector = Join-Path (Split-Path -Parent $launcher) '.workbench-installation/active.json'
    $selected = Get-Content -LiteralPath $selector -Raw | ConvertFrom-Json
    if ($selected.sha256 -ne $Expected) { throw 'The installed launcher selected the wrong archive.' }
}

function New-ServiceTestArchive([string] $Name, [string] $Startup) {
    $entry = Join-Path $root 'workbench/bundle/main.cjs'
    $package = Join-Path $root "$Name.tar.gz"
    $original = [IO.File]::ReadAllBytes($entry)
    try {
        $guard = [Text.Encoding]::UTF8.GetBytes("if (process.env.WORKBENCH_WINDOWS_SCM === '1') { $Startup }`n")
        [IO.File]::WriteAllBytes($entry, [byte[]] ($guard + $original))
        Invoke-Checked 'Create owned service activation fixture' { tar.exe -czf $package -C $root workbench } | Out-Null
    } finally {
        [IO.File]::WriteAllBytes($entry, $original)
    }
    return @{ path = $package; digest = (Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash.ToLowerInvariant() }
}

function Start-ReleaseUpdate($Package) {
    return Start-FixtureNode @($launcher, 'update', '--archive', $Package.path, '--sha256', $Package.digest)
}

function Assert-ReleaseRecovery {
    Write-Output 'Reject a verified candidate that fails when started by SCM.'
    $previous = Service-ProcessId
    $broken = New-ServiceTestArchive failed-start 'process.exit(1);'
    $update = Start-ReleaseUpdate $broken
    try {
        if (-not $update.process.WaitForExit(90000) -or -not $update.errors.Wait(10000)) {
            throw 'The failed service activation did not finish restoring the previous release.'
        }
        if ($update.process.ExitCode -ne 1) { throw 'The broken service release was not rejected.' }
    } finally { Close-FixtureNode $update }
    Assert-ActiveRelease $Digest
    Wait-Service 'Running'
    if ((Service-ProcessId) -eq $previous) { throw 'The failed update did not exercise a service restart.' }
    if ((Browse (Sign-In $accounts[0]) '/projects').status -ne 200) {
        throw 'Failed activation did not restore the previous ordinary account service.'
    }
    Write-Output 'Windows restored the verified running release after failed managed activation.'

    Write-Output 'Interrupt the update after the selected coordinator launches and before it is ready.'
    $installation = Join-Path (Split-Path -Parent $launcher) .workbench-installation
    $receipt = Join-Path $installation update.json
    $selection = Join-Path $installation active.json
    $marker = Join-Path $root 'interrupted-start.ready'
    $markerPath = ConvertTo-Json -InputObject $marker -Compress
    $waiting = New-ServiceTestArchive interrupted-start "require('node:fs').writeFileSync($markerPath, 'ready'); setInterval(() => {}, 1000); return;"
    $update = Start-ReleaseUpdate $waiting
    try {
        $timer = [Diagnostics.Stopwatch]::StartNew()
        while (-not (Test-Path -LiteralPath $receipt) -or -not (Test-Path -LiteralPath $marker) -or
            (Get-Content -LiteralPath $selection -Raw | ConvertFrom-Json).sha256 -ne $waiting.digest) {
            if ($update.process.HasExited -or $timer.Elapsed.TotalSeconds -ge 45) {
                throw 'The interrupted update never selected the prepared archive.'
            }
            Start-Sleep -Milliseconds 100
        }
    } finally { Close-FixtureNode $update }
    Invoke-FixtureNode @($launcher, 'update', '--recover') | Out-Null
    Assert-ActiveRelease $Digest
    Wait-Service 'Running'
    $recovered = Service-ProcessId
    Invoke-FixtureNode @($launcher, 'update', '--recover') | Out-Null
    if ((Test-Path -LiteralPath $receipt) -or (Service-ProcessId) -ne $recovered) {
        throw 'Repeating recovery changed the already restored Windows service.'
    }
    Write-Output 'Windows recovered an interrupted release selection and kept a repeated recovery idempotent.'

    Write-Output 'Repair the damaged stable launcher from the original verified archive.'
    $originalLauncher = [IO.File]::ReadAllBytes($launcher)
    $damaged = "#!/usr/bin/env node`n// Workbench archive launcher.`nthrow new Error('owned launcher damage fixture');`n"
    [IO.File]::WriteAllText($launcher, $damaged)
    try {
        Invoke-FixtureNode @($external, 'install', '--repair', '--archive', $Archive, '--sha256', $Digest,
            '--directory', (Split-Path -Parent $launcher)) | Out-Null
    } catch {
        [IO.File]::WriteAllBytes($launcher, $originalLauncher)
        throw
    }
    $backup = @(Get-ChildItem -LiteralPath (Join-Path $installation repair) -File)
    if ($backup.Count -ne 1 -or [IO.File]::ReadAllText($backup[0].FullName) -cne $damaged -or
        (Service-ProcessId) -ne $recovered -or (Browse (Sign-In $accounts[0]) '/projects').status -ne 200) {
        throw 'Repair did not preserve the damaged launcher and its running service.'
    }
    Write-Output 'Windows repaired the owned installation launcher without interrupting the running service.'
}

function Service-ProcessId {
    (Get-CimInstance Win32_Service -Filter "Name = '$service'").ProcessId
}

function Account-Worker($Account) {
    $parent = Service-ProcessId
    $matching = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $parent" |
        Where-Object { $_.CommandLine -match '\bweb-windows-account$' -and
            (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid).Sid -eq $Account.sid })
    if ($matching.Count -ne 1) { throw 'The test could not identify its ordinary-account worker.' }
    return Get-Process -Id $matching[0].ProcessId
}

function Assert-WorkerRestart($SignIns) {
    $helper = Join-Path (Split-Path -Parent $launcher) '.workbench-installation/workbench-scm.exe'
    $ordinaryCaller = @'
const {spawnSync} = require('node:child_process');
const [helper, service, sid] = process.argv.slice(1);
const request = spawnSync(helper, ['resume', service, sid], {encoding: 'utf8'});
if (request.error || request.status !== 5 || request.stdout) {
  throw new Error('An ordinary account was able to resume a Windows worker');
}
'@
    Invoke-AccountNode $accounts[1] @('-e', $ordinaryCaller, $helper, $service, $accounts[0].sid) | Out-Null
    Write-Output 'Windows denied an ordinary account access to worker recreation.'
    $worker = Account-Worker $accounts[0]
    try {
        $worker.Kill()
        if (-not $worker.WaitForExit(10000)) { throw 'The fixture worker did not exit.' }
    } finally {
        $worker.Dispose()
    }
    Write-Output 'Windows stopped the fixture worker to test session continuity.'
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        $project = Browse $SignIns[0] '/projects'
        if ($project.status -ne 503 -or $timer.Elapsed.TotalSeconds -gt 20) { break }
        Start-Sleep -Milliseconds 100
    } while ($true)
    if ($project.status -ne 200 -or -not $project.body.Contains($accounts[0].marker) -or
        $project.body.Contains($accounts[1].marker) -or (Browse $SignIns[1] '/projects').status -ne 200) {
        throw 'Recreating the account worker did not preserve the same isolated browser sessions.'
    }
    Write-Output 'Windows recreated an exited account worker without another sign-in or cross-account access.'
}

function Assert-IdleWorkers($SignIns) {
    $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get, "$origin/events")
    $request.Headers.Authorization = $SignIns[0]
    $response = $null
    $active = $null
    $inactive = $null
    try {
        $response = $client.SendAsync($request, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        if ([int]$response.StatusCode -ne 200 -or $response.Content.Headers.ContentType.MediaType -ne 'text/event-stream') {
            throw 'The authenticated account event stream did not start.'
        }
        $active = Account-Worker $accounts[0]
        if ((Browse $SignIns[1] '/projects').status -ne 200) { throw 'The second account worker was unavailable.' }
        $inactive = Account-Worker $accounts[1]
        if (-not $inactive.WaitForExit(30000)) { throw 'The idle Windows worker stayed running.' }
        if ($active.HasExited) { throw 'A Windows worker stopped while its event stream was open.' }
    } finally {
        if ($response) { $response.Dispose() }
        $request.Dispose()
        if ($inactive) { $inactive.Dispose() }
        if ($active) {
            try {
                if (-not $active.WaitForExit(30000)) { throw 'The Windows worker stayed running after its event stream closed.' }
            } finally { $active.Dispose() }
        }
    }
    for ($index = 0; $index -lt 2; $index++) {
        $project = Browse $SignIns[$index] '/projects'
        if ($project.status -ne 200 -or -not $project.body.Contains($accounts[$index].marker) -or
            $project.body.Contains($accounts[1 - $index].marker)) {
            throw 'Windows did not recreate an idle worker under its existing account session.'
        }
    }
    Write-Output 'Windows retired idle workers, preserved an open event stream, and recreated both workers from existing sessions.'
}

function Assert-CoordinatorDiagnostics($SignIns) {
    $sessions = @(Get-ChildItem -LiteralPath $serviceLogs -Directory |
        Where-Object { $previousLogs -notcontains $_.FullName })
    $observed = $false
    foreach ($session in $sessions) {
        if (Get-ChildItem -LiteralPath $session.FullName -Filter 'stdout.log*' -Recurse) {
            throw 'The SCM control stream entered the retained service transcript.'
        }
        $events = Workbench @('logs', 'read', $session.FullName) | Out-String
        if ($events -match '"operation":"web\.service"') { $observed = $true }
        foreach ($signIn in $SignIns) {
            $secret = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($signIn.Parameter)).Split(':', 2)[1]
            if ($events.Contains($secret)) { throw 'A sign-in credential entered structured service logs.' }
        }
    }
    if (-not $observed) { throw 'The Workbench SCM coordinator retained no service lifecycle event.' }
}

function Start-PrivateService($Account) {
    $text = Invoke-Account $Account @('serve', '--daemon', '--port', '0')
    $url = [regex]::Match($text, '(?m)^Workbench web UI: (http://127\.0\.0\.1:\d+)\r?$').Groups[1].Value
    $name = [regex]::Match($text, '(?m)^Sign-in username: ([^\r\n]+)').Groups[1].Value
    $secret = [regex]::Match($text, '(?m)^Sign-in password: ([A-Za-z0-9_-]{43})').Groups[1].Value
    $server = [regex]::Match($text, '(?m)^Server PID: ([0-9]+)').Groups[1].Value
    if (-not $url -or $name -ne $Account.name -or -not $secret -or -not $server) {
        throw 'Private Workbench discovery did not report the expected authority and listener.'
    }
    return @{
        url = $url; process = [int]$server
        authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new(
            'Basic', [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("${name}:$secret"))
        )
    }
}

function Stop-PrivateService($Account) {
    if (-not $Account.privateAttempted) { return }
    $releaseDirectory = Join-Path (Split-Path -Parent ($Account.launcher ?? $launcher)) '.workbench-installation\releases\'
    $listeners = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
        $_.ExecutablePath -eq $nodeExe -and $_.CommandLine -and
        $_.CommandLine -match '(?:^|\s)"?serve"?\s+"?--service"?(?:\s|$)' -and
        $_.CommandLine.IndexOf($releaseDirectory, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid).Sid -eq $Account.sid
    })
    if ($Account.access -and $Account.access.process -notin $listeners.ProcessId -and
        (Get-Process -Id $Account.access.process -ErrorAction SilentlyContinue)) {
        throw 'Could not verify the recorded fixture listener before stopping it.'
    }
    foreach ($process in $listeners) {
        $server = $process.ProcessId
        $brokers = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $server" |
            Where-Object { $_.CommandLine -match '\bprivate-listen\b' } |
            ForEach-Object { Get-Process -Id ([int]$_.ProcessId) -ErrorAction SilentlyContinue })
        $running = Get-Process -Id $server
        try {
            $running.Kill()
            if (-not $running.WaitForExit(10000)) { throw 'The private fixture listener did not exit.' }
            foreach ($broker in $brokers) {
                if (-not $broker.WaitForExit(10000)) { throw 'The private control broker outlived its listener.' }
            }
        } finally {
            $running.Dispose()
            foreach ($broker in $brokers) { $broker.Dispose() }
        }
    }
    $Account.access = $null
}

function Assert-WaitingForPrivate {
    for ($attempt = 0; $attempt -lt 4; $attempt++) {
        if ((Get-Service -Name $service).Status -ne 'Running' -or (Service-Readiness) -ne 'starting') {
            throw 'The SCM service did not remain stoppable while waiting for private listeners.'
        }
        $probe = [Net.Sockets.TcpClient]::new()
        try {
            $probe.Connect('127.0.0.1', $port)
            throw 'The shared browser port accepted a connection before private listeners stopped.'
        } catch [Net.Sockets.SocketException] {
            if ($_.Exception.SocketErrorCode -ne [Net.Sockets.SocketError]::ConnectionRefused) { throw }
        } finally {
            $probe.Dispose()
        }
        Start-Sleep -Milliseconds 250
    }
}

function Assert-ServiceHandoff {
    foreach ($account in $accounts) {
        $account.privateAttempted = $true
        $account.access = Start-PrivateService $account
    }
    Start-Service -Name $service
    Assert-WaitingForPrivate
    Stop-Service -Name $service
    Wait-Service 'Stopped'
    foreach ($account in $accounts) {
        $same = Start-PrivateService $account
        if ($same.process -ne $account.access.process -or
            (Browse $account.access.authorization '/projects' 'GET' $account.access.url).status -ne 200) {
            throw 'Cancelling a waiting shared service disturbed a private listener.'
        }
    }
    Start-Service -Name $service
    Assert-WaitingForPrivate
    Stop-PrivateService $accounts[0]
    $pending = Start-FixtureNode @($launcher, 'serve', '--daemon', '--port', '0') $accounts[0]
    try {
        Assert-WaitingForPrivate
        if ($pending.process.HasExited) { throw 'The other account bypassed the waiting shared service.' }
        Stop-PrivateService $accounts[1]
        Wait-Service 'Running'
        $first = Read-SignIn $accounts[0] (Read-FixtureOutput $pending)
    } finally { Close-FixtureNode $pending }
    $owner = @($first, (Sign-In $accounts[1] @('serve', '--daemon', '--port', '0')))
    for ($index = 0; $index -lt 2; $index++) {
        $project = Browse $owner[$index] '/projects'
        if ($project.status -ne 200 -or -not $project.body.Contains($accounts[$index].marker) -or
            $project.body.Contains($accounts[1 - $index].marker)) {
            throw 'Shared-first background start did not use the isolated worker for that account.'
        }
    }
    Write-Output 'Windows verified private-first, shared-first, cross-account waiting, and cancellable startup.'
    Stop-Service -Name $service
    Wait-Service 'Stopped'
}

function Assert-PrivateServices {
    foreach ($account in $accounts) {
        $installation = Join-Path $account.project installed
        $account.launcher = Join-Path $installation workbench.cjs
        Write-Output 'Install a verified release under an ordinary account.'
        Invoke-AccountNode $account @($external, 'install', '--archive', $Archive, '--sha256', $Digest,
            '--directory', $installation) | Out-Null
        Write-Output 'Register and inspect an ordinary-account logon task.'
        Invoke-Account $account @('install', '--service', 'user', '--port', '0') | Out-Null
        $account.task = "Workbench.Private.$($account.sid)"
        Invoke-Account $account @('install', '--service', 'user', '--port', '0') | Out-Null
        $task = Get-ScheduledTask -TaskPath '\' -TaskName $account.task
        if ($task.Principal.LogonType -ne 'Interactive' -or $task.Principal.RunLevel -ne 'Limited' -or
            $task.Actions.Arguments -notlike '*serve --service --port 0') {
            throw 'Windows registered the wrong private startup action or logon authority.'
        }
        Write-Output 'Start and rediscover the account-owned private listener.'
        $account.privateAttempted = $true
        $account.access = Start-PrivateService $account
        $same = Start-PrivateService $account
        if ($same.process -ne $account.access.process -or $same.url -ne $account.access.url -or
            $same.authorization.Parameter -cne $account.access.authorization.Parameter) {
            throw 'Windows private discovery opened a second listener or issued a different private credential.'
        }
    }
    for ($index = 0; $index -lt 2; $index++) {
        $account = $accounts[$index]
        $other = $accounts[1 - $index]
        $project = Browse $account.access.authorization '/projects' 'GET' $account.access.url
        if ($project.status -ne 200 -or -not $project.body.Contains($account.marker) -or
            $project.body.Contains($other.marker) -or
            (Browse $other.access.authorization '/projects' 'GET' $account.access.url).status -ne 401) {
            throw 'Windows private browser access crossed the authenticated account.'
        }
    }
    $parent = $accounts[0].access.process
    $child = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $parent" |
        Where-Object { $_.CommandLine -match '\bprivate-listen\b' })
    if ($child.Count -ne 1) { throw 'The private fixture control broker was unavailable.' }
    $instance = [regex]::Match($child[0].CommandLine, '\bprivate-listen ([a-f0-9]{32}) ').Groups[1].Value
    if (-not $instance) { throw 'The fixture control broker did not report its instance.' }
    $pipe = "\\.\pipe\Workbench-Private-$($accounts[0].sid)-$instance"
    $probe = @'
const {createConnection} = require('node:net');
const connection = createConnection({path: process.argv[1]});
connection.once('connect', () => {
  connection.destroy();
  throw new Error('Another Windows account opened the private Workbench pipe');
});
connection.once('error', (error) => {
  if (!['EACCES', 'EPERM'].includes(error.code)) throw error;
});
'@
    Invoke-AccountNode $accounts[1] @('-e', $probe, $pipe) | Out-Null
    Write-Output 'Restart the private listener and verify its previous credential is refused.'
    $older = $accounts[0].access.authorization
    $previousProcess = $accounts[0].access.process
    Stop-PrivateService $accounts[0]
    $accounts[0].access = Start-PrivateService $accounts[0]
    if ($accounts[0].access.process -eq $previousProcess -or
        (Browse $older '/projects' 'GET' $accounts[0].access.url).status -ne 401) {
        throw 'The Windows private listener did not restart with fresh sign-in.'
    }
    Write-Output 'Windows verified two private listeners, duplicate discovery, and fresh credentials after restart.'
    Write-Output 'Windows denied another ordinary account access to the native private discovery pipe.'
    Write-Output 'Windows registered and inspected two ordinary-account interactive logon tasks.'
    Write-Output 'Interactive desktop logon is outside this secondary-logon fixture.'
}


function Start-DesktopTask($Account) {
    Start-ScheduledTask -TaskPath '\' -TaskName $Account.task
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        $listeners = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe' AND SessionId = $desktopSession" |
            Where-Object {
                $_.ExecutablePath -eq $nodeExe -and $_.CommandLine -and
                $_.CommandLine -match '(?:^|\s)"?serve"?\s+"?--service"?(?:\s|$)' -and
                $_.CommandLine.IndexOf($launcher, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
                (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid).Sid -eq $Account.sid
            })
        if ($listeners.Count -eq 1 -and
            (Get-ScheduledTask -TaskPath '\' -TaskName $Account.task).State -eq 'Running') { break }
        if ($timer.Elapsed.TotalSeconds -ge 45) {
            $result = (Get-ScheduledTaskInfo -TaskPath '\' -TaskName $Account.task).LastTaskResult
            throw "The installed interactive task did not launch one account-owned listener (result $result)."
        }
        Start-Sleep -Milliseconds 250
    } while ($true)
    $Account.access = Start-PrivateService $Account
    if ($Account.access.process -ne $listeners[0].ProcessId -or
        (Browse $Account.access.authorization '/projects' 'GET' $Account.access.url).status -ne 200) {
        throw 'The installed CLI did not discover the Task Scheduler listener in the signed-in desktop session.'
    }
}

function Stop-DesktopTask($Account) {
    $registration = Get-ScheduledTask -TaskPath '\' -TaskName $Account.task -ErrorAction SilentlyContinue
    if ($registration -and $registration.State -in 'Queued', 'Running') {
        Stop-ScheduledTask -TaskPath '\' -TaskName $Account.task
    }
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while (($Account.access -and (Get-Process -Id $Account.access.process -ErrorAction SilentlyContinue)) -or
        ($registration -and (Get-ScheduledTask -TaskPath '\' -TaskName $Account.task).State -in 'Queued', 'Running')) {
        if ($timer.Elapsed.TotalSeconds -ge 20) { throw 'Task Scheduler did not stop the owned fixture task.' }
        Start-Sleep -Milliseconds 250
    }
    $Account.access = $null
}

function Assert-DesktopTaskReleaseLifecycle {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $sid = $identity.User.Value
    $sessions = @(Get-CimInstance Win32_Process -Filter "Name = 'explorer.exe' AND SessionId > 0" |
        Where-Object { (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid).Sid -eq $sid } |
        Select-Object -ExpandProperty SessionId -Unique)
    if ($sessions.Count -ne 1) { throw 'The Windows user-service qualification needs one signed-in desktop session.' }
    $script:desktopSession = $sessions[0]
    $replacement = if ($Replacement) { @{ path = $Replacement; digest = $ReplacementDigest } }
        else { New-ServiceTestArchive 'private-replacement' 'void 0;' }
    $project = (New-Item -ItemType Directory -Path (Join-Path $root desktop-fixture)).FullName
    $account = @{name = $identity.Name.Split('\')[-1]; sid = $identity.User.Value; launcher = $launcher; project = $project}
    if (Get-ScheduledTask -TaskPath '\' -TaskName "Workbench.Private.$($account.sid)" -ErrorAction SilentlyContinue) {
        throw 'Use an interactive disposable account without a pre-existing Workbench task.'
    }
    Workbench @('install', '--service', 'user', '--port', '0') | Out-Null
    $account.task = "Workbench.Private.$($account.sid)"
    $script:desktopAccount = $account
    $scheduled = Get-ScheduledTask -TaskPath '\' -TaskName $account.task
    if ($scheduled.Principal.LogonType -ne 'Interactive' -or $scheduled.Principal.RunLevel -ne 'Limited') {
        throw 'The installed logon task did not retain the expected logon and privilege settings.'
    }
    Start-DesktopTask $account
    $previous = $account.access
    Write-Output 'The native Task Scheduler started the installed private server in the signed-in desktop session.'

    $update = Start-ReleaseUpdate $replacement
    try {
        if (-not $update.process.WaitForExit(60000) -or -not $update.errors.Wait(10000)) {
            throw 'The active-task update did not settle.'
        }
        $failure = ($update.errors.GetAwaiter().GetResult() -replace '\s+', ' ')
        if ($update.process.ExitCode -ne 1 -or $failure -notmatch 'before switching installed releases') {
            throw 'The installed updater did not report the expected active listener guard.'
        }
    } finally { Close-FixtureNode $update }
    Assert-ActiveRelease $Digest
    $live = Start-PrivateService $account
    if ($live.process -ne $previous.process -or
        (Browse $previous.authorization '/projects' 'GET' $previous.url).status -ne 200 -or
        (Test-Path -LiteralPath (Join-Path $root installed/.workbench-installation/update.json))) {
        throw 'The rejected active-task update disrupted the installed listener or left a partial release transition.'
    }
    Write-Output 'The installer preserved the live scheduled task and verified release when an update was requested.'

    Stop-DesktopTask $account
    Workbench @('update', '--archive', $replacement.path, '--sha256', $replacement.digest) | Out-Null
    Assert-ActiveRelease $replacement.digest
    Start-DesktopTask $account
    if ($account.access.process -eq $previous.process -or
        (Browse $previous.authorization '/projects' 'GET' $account.access.url).status -ne 401) {
        throw 'The restarted scheduled task did not require fresh browser sign-in.'
    }
    Stop-DesktopTask $account
    Workbench @('update', '--rollback') | Out-Null
    Assert-ActiveRelease $Digest
    Start-DesktopTask $account
    Write-Output 'Windows verified stopped-task update and rollback with actual Task Scheduler launches and fresh authentication.'
}

try {
    New-Item -ItemType Directory -Path $root | Out-Null
    $created = $true
    Copy-Item -LiteralPath (Resolve-Path -LiteralPath $Node).ProviderPath -Destination $nodeExe
    Invoke-Checked 'Extract candidate installer' { tar.exe -xzf $Archive -C $root } | Out-Null
    Invoke-Checked 'Verified archive installation' {
        & $nodeExe $external install --archive $Archive --sha256 $Digest --directory (Split-Path -Parent $launcher)
    } | Out-Null
    Assert-ActiveRelease $Digest
    if ($DesktopTask) {
        Assert-DesktopTaskReleaseLifecycle
        return
    }
    Invoke-Checked 'Protect fixture ownership' { icacls.exe $root /setowner '*S-1-5-32-544' /T /Q } | Out-Null
    Invoke-Checked 'Protect fixture permissions' {
        icacls.exe $root /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' /Q
    } | Out-Null

    $group = Get-LocalGroup -SID ([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'))
    foreach ($index in 1, 2) {
        $name = "wb$suffix$index"
        $password = ConvertTo-SecureString ('Aa1!' + [guid]::NewGuid().ToString('N')) -AsPlainText -Force
        $user = New-LocalUser -Name $name -Password $password
        $project = Join-Path $root $user.SID.Value
        $marker = "Windows qualification project $index"
        $account = @{name = $name; sid = $user.SID.Value; password = $password; project = $project; marker = $marker}
        $accounts += $account
        if (-not (Get-LocalGroupMember -Group $group | Where-Object { $_.SID -eq $user.SID })) {
            Add-LocalGroupMember -Group $group -Member $user
        }
        New-Item -ItemType Directory -Path (Join-Path $project workbench) -Force | Out-Null
        $sid = $user.SID.Value
        Invoke-Checked 'Protect separate account project' {
            icacls.exe $project /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "*${sid}:(OI)(CI)M" /Q
        } | Out-Null
        [IO.File]::WriteAllText((Join-Path $project workbench/projects.toml),
            "[[project]]`nid = `"qualification`"`nname = `"$marker`"`npath = `".`"`n")
        Invoke-Account $account @('project', 'add', $project) | Out-Null
    }
    if ($PrivateService) {
        Assert-PrivateServices
        return
    }
    Assert-PortOwnership $false
    Workbench @('install', '--service', 'system', '--port', [string]$port) | Out-Null
    $registered = $true
    Workbench @('install', '--service', 'system', '--port', [string]$port) | Out-Null
    if (-not $Replacement) {
        $startMode = (Get-Service -Name $service).StartType
        if ($startMode -ne [System.ServiceProcess.ServiceStartMode]::Automatic) {
            throw "The installed system service has startup mode $startMode. Expected Automatic."
        }
    }
    if ($IdleWorkers) {
        $configuration = Join-Path $root daemon-config
        New-Item -ItemType Directory -Path $configuration | Out-Null
        Set-Content -LiteralPath (Join-Path $configuration config.toml) -Value @('[daemon]', 'worker_idle_seconds = 8')
        $environment = @{
            Path = "HKLM:\SYSTEM\CurrentControlSet\Services\$service"
            Name = 'Environment'
            PropertyType = 'MultiString'
            Value = @("WORKBENCH_CONFIG_HOME=$configuration")
        }
        New-ItemProperty @environment | Out-Null
    }
    if ($Handoff) { Assert-ServiceHandoff }
    Assert-PortOwnership $true
    Start-Service -Name $service
    Wait-Service 'Running'
    Assert-PortOwnership $true
    if ((Browse $null '/projects').status -ne 401) { throw 'The protected origin accepted an anonymous browser.' }
    $signIns = @((Sign-In $accounts[0]), (Sign-In $accounts[1]))
    for ($index = 0; $index -lt 2; $index++) {
        $project = Browse $signIns[$index] '/projects'
        if ($project.status -ne 200 -or -not $project.body.Contains($accounts[$index].marker) -or
            $project.body.Contains($accounts[1 - $index].marker)) {
            throw 'A Windows browser session did not stay in its authenticated account.'
        }
    }
    if ($ResumeWorker) { Assert-WorkerRestart $signIns }
    if ($IdleWorkers) { Assert-IdleWorkers $signIns }
    if ((Browse $signIns[1] '/sign-out' 'POST').status -ne 200 -or
        (Browse $signIns[1] '/projects').status -ne 401 -or (Browse $signIns[0] '/projects').status -ne 200) {
        throw 'Windows browser sign-out affected the wrong credential.'
    }
    if ($Recovery) { Assert-ReleaseRecovery }
    if ($Replacement) {
        $originalProcess = Service-ProcessId
        Workbench @('update', '--archive', $Replacement, '--sha256', $ReplacementDigest) | Out-Null
        Wait-Service 'Running'
        Assert-ActiveRelease $ReplacementDigest
        $replacementProcess = Service-ProcessId
        if (-not $replacementProcess -or $replacementProcess -eq $originalProcess) {
            throw 'The update did not restart the managed Workbench process.'
        }
        $replacementSignIn = Sign-In $accounts[0]
        $signIns += $replacementSignIn
        if ((Browse $replacementSignIn '/projects').status -ne 200) { throw 'The replacement did not serve projects.' }
        Workbench @('update', '--rollback') | Out-Null
        Wait-Service 'Running'
        Assert-ActiveRelease $Digest
        $rollbackProcess = Service-ProcessId
        if (-not $rollbackProcess -or $rollbackProcess -eq $replacementProcess) {
            throw 'Rollback did not restart the managed Workbench process.'
        }
        Write-Output "Windows verified installed update and rollback between archives $Digest and $ReplacementDigest."
    } else {
        Restart-Service -Name $service
        Wait-Service 'Running'
    }
    if ((Browse $signIns[0] '/projects').status -ne 401) {
        throw 'A Windows credential survived loss of the original account token.'
    }
    $fresh = Sign-In $accounts[0]
    if ((Browse $fresh '/projects').status -ne 200) { throw 'The restarted installed service did not accept fresh sign-in.' }
    Stop-Service -Name $service
    Wait-Service 'Stopped'
    Assert-CoordinatorDiagnostics ($signIns + $fresh)
    Assert-PortOwnership $true
    Workbench @('uninstall', '--service', 'system') | Out-Null
    $registered = $false
    Assert-PortOwnership $false
    if (-not (Test-Path -LiteralPath $launcher) -or -not (Test-Path -LiteralPath $accounts[0].project)) {
        throw 'Service removal deleted the installed command or account data.'
    }
    Write-Output 'Windows verified installed CLI sign-in, account isolation, restart, and owned service removal.'
} catch {
    Write-Error -ErrorRecord $_ -ErrorAction Continue
    throw
} finally {
    $client.Dispose()
    $cleanup = @()
    if ($desktopAccount) {
        try {
            Stop-DesktopTask $desktopAccount
            Workbench @('uninstall', '--service', 'user') | Out-Null
            if (Get-ScheduledTask -TaskPath '\' -TaskName $desktopAccount.task -ErrorAction SilentlyContinue) {
                throw 'The interactive Workbench fixture registration survived owned removal.'
            }
        } catch { $cleanup += $_ }
    }
    if ($registered) {
        try {
            if ((Get-Service -Name $service).Status -ne 'Stopped') { Stop-Service -Name $service }
            Wait-Service 'Stopped'
            if (Test-Path -LiteralPath (Join-Path $root installed/.workbench-installation/update.json)) {
                Workbench @('update', '--recover') | Out-Null
                Stop-Service -Name $service
                Wait-Service 'Stopped'
            }
            Workbench @('uninstall', '--service', 'system') | Out-Null
            $registered = $false
        } catch { $cleanup += $_ }
    }
    foreach ($account in $accounts) {
        try {
            Stop-PrivateService $account
            if ($account.task) {
                Invoke-Account $account @('uninstall', '--service', 'user') | Out-Null
                if (Get-ScheduledTask -TaskPath '\' -TaskName $account.task -ErrorAction SilentlyContinue) {
                    throw 'The Workbench private logon task survived removal.'
                }
                if (-not (Test-Path -LiteralPath $account.launcher)) {
                    throw 'Removing the Workbench logon task deleted the installed launcher.'
                }
            }
            Remove-LocalUser -Name $account.name
            $profile = Get-CimInstance Win32_UserProfile -Filter "SID = '$($account.sid)'"
            if ($profile -and $profile.Loaded) { throw 'A fixture account profile remained loaded after shutdown.' }
            if ($profile) { Remove-CimInstance -InputObject $profile }
        } catch { $cleanup += $_ }
    }
    try {
        if ($created -and -not $registered) { Remove-Item -LiteralPath $root -Force -Recurse }
    } catch { $cleanup += $_ }
    foreach ($issue in $cleanup) { Write-Error -ErrorRecord $issue -ErrorAction Continue }
    if ($cleanup.Count) { throw 'Windows qualification cleanup was incomplete.' }
}

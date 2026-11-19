param(
    [Parameter(Mandatory)][string] $Probe,
    [Parameter(Mandatory)][string] $IdentityProbe,
    [ValidateRange(1024, 49151)][int] $Port = 37947
)

$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run the test from an elevated terminal on a disposable Windows host.'
}

$suffix = [guid]::NewGuid().ToString('N').Substring(0, 10)
$service = "WorkbenchPortTest-$suffix"
$directory = Join-Path $env:ProgramFiles $service
$executable = Join-Path $directory 'port-probe.exe'
$identityExecutable = Join-Path $directory 'identity-probe.exe'
$identityService = "$service-Identity"
$usernames = @()
$userSids = @()
$credentials = @()
$registrations = @()
$createdDirectory = $false
$reserved = $false

function Invoke-AdministratorProbe([string] $Mode) {
    & $executable $Mode $Port
    if ($LASTEXITCODE -ne 0) {
        throw "Administrator probe $Mode failed with status $LASTEXITCODE."
    }
}

function Assert-UserProbe(
    [string] $Mode,
    [int[]] $Expected,
    [string] $Binary = $executable,
    [string] $ServiceArgument = "$Port"
) {
    foreach ($credential in $credentials) {
        $options = @{
            Credential = $credential
            FilePath = $Binary
            ArgumentList = @($Mode, $ServiceArgument)
            LoadUserProfile = $true
            WorkingDirectory = $directory
            PassThru = $true
        }
        $process = Start-Process @options
        if (-not $process.WaitForExit(15000)) {
            $process.Kill()
            throw "User probe $Mode timed out."
        }
        if ($Expected -notcontains $process.ExitCode) {
            throw "User probe $Mode returned $($process.ExitCode); expected $($Expected -join ' or ')."
        }
    }
}

function Assert-OriginBindings([int[]] $Expected) {
    foreach ($mode in 'bind', 'bind-wildcard', 'bind-dual-stack') {
        Assert-UserProbe $mode $Expected
    }
}

try {
    New-Item -ItemType Directory -Path $directory | Out-Null
    $createdDirectory = $true
    $probePath = (Resolve-Path -LiteralPath $Probe).ProviderPath
    Copy-Item -LiteralPath $probePath -Destination $executable
    Copy-Item -LiteralPath (Resolve-Path -LiteralPath $IdentityProbe).ProviderPath -Destination $identityExecutable
    $group = Get-LocalGroup -SID ([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'))
    foreach ($index in 1, 2) {
        $name = "wb$suffix$index"
        $value = 'Aa1!' + [guid]::NewGuid().ToString('N')
        $password = ConvertTo-SecureString -String $value -AsPlainText -Force
        $value = $null
        $user = New-LocalUser -Name $name -Password $password
        $usernames += $name
        if (-not (Get-LocalGroupMember -Group $group | Where-Object { $_.SID -eq $user.SID })) {
            Add-LocalGroupMember -Group $group -Member $user
        }
        $credentials += [PSCredential]::new("$env:COMPUTERNAME\$name", $password)
        $sid = $user.SID.Value
        $userSids += $sid
        $private = Join-Path $directory $sid
        New-Item -ItemType Directory -Path $private | Out-Null
        & icacls.exe $private /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "*${sid}:(OI)(CI)RX"
        if ($LASTEXITCODE -ne 0) { throw 'Setting the private fixture ACL failed.' }
        [IO.File]::WriteAllText((Join-Path $private 'fixture.txt'), 'Workbench private fixture', [Text.Encoding]::ASCII)
    }
    $failures = @()
    try {
        Assert-OriginBindings @(0)
        Invoke-AdministratorProbe 'reserve'
        $reserved = $true
        Assert-OriginBindings @(10013, 10048)
        Assert-UserProbe 'bind-with-reservation' @(5, 10013, 10048)
        Assert-UserProbe 'connect' @(10061)

        $serviceOptions = @{
            Name = $service
            BinaryPathName = ('"{0}" service {1} {2}' -f $executable, $Port, $service)
            StartupType = 'Manual'
        }
        New-Service @serviceOptions | Out-Null
        $registrations += $service
        foreach ($start in 1, 2) {
            Start-Service -Name $service
            (Get-Service -Name $service).WaitForStatus('Running', [TimeSpan]::FromSeconds(15))
            Assert-UserProbe 'connect' @(0)
            Assert-OriginBindings @(10013, 10048)
            Stop-Service -Name $service
            (Get-Service -Name $service).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(15))
            Assert-UserProbe 'connect' @(10061)
            Assert-OriginBindings @(10013, 10048)
            Assert-UserProbe 'bind-with-reservation' @(5, 10013, 10048)
        }
        Invoke-AdministratorProbe 'release'
        $reserved = $false
        Assert-OriginBindings @(0)
        Write-Output 'Two ordinary users verified TCP reservation before, during, and after native SCM startup and restart.'
    } catch {
        $failures += $_
    }

    try {
        $identityOptions = @{
            Name = $identityService
            BinaryPathName = ('"{0}" service {1} "{2}" {3} {4}' -f $identityExecutable, $identityService, $directory, $userSids[0], $userSids[1])
            StartupType = 'Manual'
        }
        New-Service @identityOptions | Out-Null
        $registrations += $identityService
        Start-Service -Name $identityService
        (Get-Service -Name $identityService).WaitForStatus('Running', [TimeSpan]::FromSeconds(15))
        Assert-UserProbe 'request' @(0) $identityExecutable $identityService
        Stop-Service -Name $identityService
        (Get-Service -Name $identityService).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(15))
        Write-Output 'Two SCM-spawned workers matched their pipe clients and read only their own fixture.'
    } catch {
        $failures += $_
    }
    foreach ($issue in $failures) {
        Write-Error -ErrorRecord $issue -ErrorAction Continue
    }
    if ($failures.Count) { throw 'A native Windows boundary did not qualify.' }
} finally {
    $cleanup = @()
    foreach ($registration in $registrations) {
        try {
            if ((Get-Service -Name $registration).Status -ne 'Stopped') {
                Stop-Service -Name $registration
            }
            (Get-Service -Name $registration).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(15))
            & sc.exe delete $registration
            if ($LASTEXITCODE -ne 0) { throw 'Probe service removal failed.' }
        } catch {
            $cleanup += $_
        }
    }
    if ($reserved) {
        try { Invoke-AdministratorProbe 'release' } catch { $cleanup += $_ }
    }
    foreach ($name in $usernames) {
        try { Remove-LocalUser -Name $name } catch { $cleanup += $_ }
    }
    foreach ($sid in $userSids) {
        try {
            $profile = Get-CimInstance Win32_UserProfile -Filter "SID = '$sid'"
            if ($profile -and $profile.Loaded) {
                throw "The fixture user profile remained loaded after the probes exited."
            }
            if ($profile) { Remove-CimInstance -InputObject $profile }
        } catch {
            $cleanup += $_
        }
    }
    try {
        if ($createdDirectory) {
            Remove-Item -LiteralPath $directory -Force -Recurse
        }
    } catch {
        $cleanup += $_
    }
    foreach ($issue in $cleanup) {
        Write-Error -ErrorRecord $issue -ErrorAction Continue
    }
    if ($cleanup.Count) { throw 'Windows probe cleanup was incomplete.' }
}

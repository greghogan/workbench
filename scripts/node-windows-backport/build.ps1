param([Parameter(Mandatory)][string]$OutputDirectory)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$pin = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'pin.json') -Raw | ConvertFrom-Json
if ($pin.version -notmatch '^\d+\.\d+\.\d+$' -or $pin.signer -notmatch '^[A-F0-9]{40}$') {
  throw 'Invalid Windows Node source pin'
}
$version = $pin.version
$patch = Join-Path $PSScriptRoot 'appcontainer-pipes.patch'
$keys = Join-Path $PSScriptRoot '../keys/node.asc'
$base = "https://nodejs.org/dist/v$version"
$sourceName = "node-v$version.tar.gz"
$distribution = "node-v$version-win-x64"
$archiveName = "$distribution.zip"
$output = New-Item -ItemType Directory -Path $OutputDirectory -Force
$archive = Join-Path $output.FullName "$distribution-workbench.zip"
if (Test-Path -LiteralPath $archive) { throw "Output already exists: $archive" }

function Invoke-Checked([string]$Program, [string[]]$Arguments) {
  & $Program @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Program exited with status $LASTEXITCODE" }
}

function Fetch-File([string]$Name, [string]$Root = $base) {
  Invoke-Checked 'curl.exe' @(
    '--proto', '=https', '--proto-redir', '=https', '--fail', '--silent', '--show-error',
    '--location', '--retry', '3', '--connect-timeout', '15', '--max-time', '300',
    '--output', (Join-Path $work $Name), "$Root/$Name"
  )
}

function Assert-Hash([string]$Path, [string]$Expected) {
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash
  if ($Expected -notmatch '^[A-Fa-f0-9]{64}$' -or $actual -ne $Expected) {
    throw "Digest mismatch: $Path"
  }
}

function Assert-ReleaseFile([string]$Name, [string]$Expected) {
  $pattern = '^([A-Fa-f0-9]{64})\s+\*?' + [regex]::Escape($Name) + '$'
  $match = @(Get-Content -LiteralPath (Join-Path $work 'SHASUMS256.txt') |
    ForEach-Object { [regex]::Match($_, $pattern) } | Where-Object Success)
  if ($match.Count -ne 1 -or $match[0].Groups[1].Value -ne $Expected) {
    throw "Signed Node release does not match its pin: $Name"
  }
  Assert-Hash (Join-Path $work $Name) $Expected
}

Assert-Hash $patch $pin.patchSha256
$gpg = (Get-Command gpg.exe -ErrorAction SilentlyContinue).Source
if (-not $gpg) {
  $git = & git --exec-path
  if ($LASTEXITCODE -ne 0) { throw 'Cannot locate Git for Windows' }
  $gpg = Join-Path $git '../../../usr/bin/gpg.exe'
}
if (-not (Test-Path -LiteralPath $gpg -PathType Leaf)) { throw 'GnuPG is required to verify the Node release' }
$temporary = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$work = Join-Path $temporary ('wb-node-' + [guid]::NewGuid().ToString('N').Substring(0, 12))
$keysHome = Join-Path $work 'gnupg'
$source = Join-Path $work 'src'
New-Item -ItemType Directory -Path $work | Out-Null
$originalPath = $env:PATH
try {
  New-Item -ItemType Directory -Path $keysHome, $source | Out-Null
  foreach ($name in @('SHASUMS256.txt', 'SHASUMS256.txt.sig', $sourceName, $archiveName)) {
    Fetch-File $name
  }
  Invoke-Checked $gpg @('--homedir', $keysHome, '--batch', '--import', $keys)
  $signature = Invoke-Checked $gpg @(
    '--homedir', $keysHome, '--batch', '--no-auto-key-retrieve', '--status-fd', '1',
    '--verify', (Join-Path $work 'SHASUMS256.txt.sig'), (Join-Path $work 'SHASUMS256.txt')
  )
  $valid = @($signature | Where-Object {
    $_ -match '^\[GNUPG:\] VALIDSIG ' -and $pin.signer -in ($_ -split ' ')
  })
  if ($valid.Count -ne 1) { throw 'Node release checksum signer did not match the pin' }
  Assert-ReleaseFile $sourceName $pin.sourceSha256
  Assert-ReleaseFile $archiveName $pin.windowsArchiveSha256

  # The NASM distributor has no signature alongside this executable archive.
  $nasmVersion = $pin.nasm.version
  if ($nasmVersion -notmatch '^\d+\.\d+(\.\d+)?$') { throw 'Invalid NASM version pin' }
  $nasmName = "nasm-$nasmVersion-win64.zip"
  Fetch-File $nasmName "https://www.nasm.us/pub/nasm/releasebuilds/$nasmVersion/win64"
  $nasmArchive = Join-Path $work $nasmName
  Assert-Hash $nasmArchive $pin.nasm.sha256
  Expand-Archive -LiteralPath $nasmArchive -DestinationPath (Join-Path $work 'assembler')
  $nasm = @(Get-ChildItem (Join-Path $work 'assembler') -Recurse -Filter 'nasm.exe')
  if ($nasm.Count -ne 1) { throw 'Expected one NASM executable' }
  $env:PATH = "$($nasm[0].DirectoryName);$env:PATH"

  Invoke-Checked 'tar.exe' @('-xzf', (Join-Path $work $sourceName), '-C', $source, '--strip-components=1')
  Push-Location $source
  try {
    Invoke-Checked 'git' @('apply', '--check', $patch)
    Invoke-Checked 'git' @('apply', $patch)
    Invoke-Checked 'cmd.exe' @('/D', '/C', 'vcbuild.bat release x64 full-icu download-all nonpm no-cctest')
  } finally {
    Pop-Location
  }

  $packageRoot = Join-Path $work 'package'
  Expand-Archive -LiteralPath (Join-Path $work $archiveName) -DestinationPath $packageRoot
  $package = Join-Path $packageRoot $distribution
  $node = Join-Path $package 'node.exe'
  Copy-Item -LiteralPath (Join-Path $source 'Release/node.exe') -Destination $node -Force
  $reported = Invoke-Checked $node @('-p', "process.platform + '/' + process.arch + ' ' + process.versions.node")
  if ($reported -ne "win32/x64 $version") { throw "Unexpected built runtime: $reported" }
  $staged = Join-Path $work 'verified.zip'
  Compress-Archive -LiteralPath $package -DestinationPath $staged
  Move-Item -LiteralPath $staged -Destination $archive
  Write-Host "Windows Node archive SHA-256 $((Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant())"
} finally {
  $env:PATH = $originalPath
  Remove-Item -LiteralPath $work -Recurse -Force
}

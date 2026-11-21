$ErrorActionPreference = 'Stop'
try {
    $digest = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'digest.txt') -Raw).Trim()
    $inputs = @{
        Node = Join-Path $PSScriptRoot 'node.exe'
        Archive = Join-Path $PSScriptRoot 'workbench.tar.gz'
        Digest = $digest
        RebootDisposableGuest = $true
        SerialLog = $true
    }
    & (Join-Path $PSScriptRoot 'verify.ps1') @inputs
} catch {
    # The guest is disposable. Avoid copying exception output or account settings into the host report.
    $serial = [IO.Ports.SerialPort]::new('COM1', 115200, [IO.Ports.Parity]::None, 8, [IO.Ports.StopBits]::One)
    $serial.WriteTimeout = 3000
    $line = $_.InvocationInfo.ScriptLineNumber
    $kind = $_.Exception.GetType().Name
    try {
        $serial.Open()
        $serial.WriteLine("WB-TEST FAIL bootstrap $line $kind")
    } finally {
        $serial.Dispose()
    }
    exit 1
}

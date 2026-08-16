[CmdletBinding()]
param(
    [string]$Version = $env:THOR_VERSION,
    [string]$Repository = $(if ($env:THOR_REPOSITORY) { $env:THOR_REPOSITORY } else { "acme/thor" }),
    [string]$BinDir = $(if ($env:THOR_BIN_DIR) { $env:THOR_BIN_DIR } else { Join-Path $HOME ".local\bin" })
)

$ErrorActionPreference = "Stop"

if (-not [Environment]::Is64BitOperatingSystem) {
    throw "Thor supports Windows x64 only."
}

$asset = "thor-windows-amd64.exe"
if ($Version) {
    $release = "https://github.com/$Repository/releases/download/$Version"
} else {
    $release = "https://github.com/$Repository/releases/latest/download"
}

$temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("thor-install-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
try {
    $download = Join-Path $temporaryDirectory $asset
    $checksums = Join-Path $temporaryDirectory "SHA256SUMS"
    Invoke-WebRequest -Uri "$release/$asset" -OutFile $download
    Invoke-WebRequest -Uri "$release/SHA256SUMS" -OutFile $checksums

    $expected = Get-Content $checksums |
        ForEach-Object {
            $parts = $_ -split '\s+', 2
            if ($parts.Count -eq 2 -and $parts[1].TrimStart('*') -eq $asset) { $parts[0] }
        } |
        Select-Object -First 1
    if (-not $expected) { throw "SHA256SUMS does not contain $asset" }
    $actual = (Get-FileHash -Algorithm SHA256 -Path $download).Hash.ToLowerInvariant()
    if ($expected.ToLowerInvariant() -ne $actual) { throw "Checksum verification failed for $asset" }

    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
    Move-Item -Force $download (Join-Path $BinDir "thor.exe")
    Write-Output "Installed Thor to $(Join-Path $BinDir 'thor.exe')"
} finally {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $temporaryDirectory
}

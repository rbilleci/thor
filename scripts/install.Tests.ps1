$ErrorActionPreference = "Stop"
$scriptPath = Join-Path $PSScriptRoot "install.ps1"

Describe "Thor PowerShell bootstrap" {
    BeforeEach {
        $script:uris = @()
        $script:expectedHash = "ab" * 32
        Mock Invoke-WebRequest {
            param([string]$Uri, [string]$OutFile)
            $script:uris += $Uri
            if ($Uri -like "*/SHA256SUMS") {
                Set-Content -NoNewline -Path $OutFile -Value "$script:expectedHash  *thor-windows-amd64.exe"
            } else {
                Set-Content -NoNewline -Path $OutFile -Value "thor test binary"
            }
        }
        Mock Get-FileHash { [PSCustomObject]@{ Hash = $script:expectedHash } }
    }

    It "uses a version-pinned release and THOR_BIN_DIR equivalent" {
        $binDir = Join-Path $TestDrive "bin"
        & $scriptPath -Version "v1.2.3" -Repository "acme/thor" -BinDir $binDir
        Test-Path (Join-Path $binDir "thor.exe") | Should -BeTrue
        $script:uris | Should -Contain "https://github.com/acme/thor/releases/download/v1.2.3/thor-windows-amd64.exe"
        $script:uris | Should -Contain "https://github.com/acme/thor/releases/download/v1.2.3/SHA256SUMS"
    }

    It "refuses a checksum mismatch" {
        Mock Get-FileHash { [PSCustomObject]@{ Hash = "00" * 32 } }
        { & $scriptPath -Version "v1.2.3" -Repository "acme/thor" -BinDir (Join-Path $TestDrive "bin") } |
            Should -Throw "Checksum verification failed*"
    }
}

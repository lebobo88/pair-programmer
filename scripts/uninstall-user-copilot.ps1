<#
.SYNOPSIS
  Remove the pair-programmer Copilot CLI plugin from user scope.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$UserCopilot = Join-Path $env:USERPROFILE '.copilot'
$Manifest = Join-Path $UserCopilot '.pp-plugin-managed.json'
$PluginName = 'pair-programmer'
$PluginListPattern = '\bpair-programmer\b'

Write-Host ""
Write-Host "Pair-programmer Copilot plugin uninstaller" -ForegroundColor Cyan
Write-Host "  user:   $UserCopilot"
Write-Host "  plugin: $PluginName"
Write-Host ""

if (Get-Command copilot -ErrorAction SilentlyContinue) {
    $listOutput = (& copilot plugin list 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to list Copilot plugins. Exit code: $LASTEXITCODE"
    }

    if (($listOutput -join "`n") -match $PluginListPattern) {
        & copilot plugin uninstall $PluginName 2>&1 | Out-Host
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to uninstall $PluginName. Exit code: $LASTEXITCODE"
        }
        Write-Host "Removed pair-programmer plugin." -ForegroundColor Yellow
    } else {
        Write-Host "pair-programmer is not currently installed." -ForegroundColor DarkYellow
    }
} else {
    Write-Warning "The copilot CLI was not found on PATH -- plugin removal was skipped."
}

if (Test-Path $Manifest) {
    Remove-Item $Manifest -Force
    Write-Host "Removed manifest $Manifest" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Uninstalled." -ForegroundColor Cyan

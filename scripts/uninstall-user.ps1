<#
.SYNOPSIS
  Reverse install-user.ps1: remove the junctions, deregister the three pp_*
  MCP servers via `claude mcp remove`, drop the harness hooks block from
  ~/.claude/settings.json, and remove the harness permission allows.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$UserClaude = Join-Path $env:USERPROFILE '.claude'
$Manifest   = Join-Path $UserClaude '.pp-managed.json'

Write-Host ""
Write-Host "Pair-programmer user-scope uninstaller" -ForegroundColor Cyan
Write-Host "  user:  $UserClaude"
Write-Host ""

$manifest = if (Test-Path $Manifest) {
    Get-Content $Manifest -Raw | ConvertFrom-Json
} else {
    Write-Warning "  no manifest found at $Manifest -- using fallback identification"
    [pscustomobject]@{
        junctions  = @(
            (Join-Path $UserClaude 'commands\pp'),
            (Join-Path $UserClaude 'agents'),
            (Join-Path $UserClaude 'skills')
        )
        mcpServers   = @('pp_harness', 'pp_codex', 'pp_agy')
        allowEntries = @()
    }
}

# 1. Remove junctions --------------------------------------------------------

foreach ($linkPath in @($manifest.junctions)) {
    if (-not (Test-Path $linkPath)) { continue }
    $item = Get-Item $linkPath -Force
    $isJunction = ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
    if ($isJunction) {
        cmd /c rmdir "`"$linkPath`"" | Out-Null
        Write-Host ("  remove junction $linkPath") -ForegroundColor Yellow
    } else {
        Write-Warning "  skip $linkPath -- not a junction; will not delete real directory"
    }
}

# 2. Deregister MCP servers via claude CLI -----------------------------------

if (Get-Command claude -ErrorAction SilentlyContinue) {
    foreach ($server in @($manifest.mcpServers)) {
        & claude mcp remove $server -s user 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-Host ("  remove mcp $server") -ForegroundColor Yellow
        }
    }
} else {
    Write-Warning "  claude CLI not found -- cannot remove MCP servers; remove manually with: claude mcp remove pp_harness -s user"
}

# 3. Strip hooks block + harness allow entries -------------------------------

$settingsPath = Join-Path $UserClaude 'settings.json'
if (Test-Path $settingsPath) {
    $settings = Get-Content $settingsPath -Raw | ConvertFrom-Json
    if ($settings.PSObject.Properties.Match('hooks')) {
        $daemonMarker = 'pair-programmer/daemon/dist/index.js'
        $hooksClone = $settings.hooks
        $allManaged = $true
        foreach ($prop in $hooksClone.PSObject.Properties) {
            foreach ($entry in @($prop.Value)) {
                foreach ($h in @($entry.hooks)) {
                    if ($h.command -and ($h.command -notmatch [regex]::Escape($daemonMarker))) {
                        $allManaged = $false
                        break
                    }
                }
                if (-not $allManaged) { break }
            }
            if (-not $allManaged) { break }
        }
        if ($allManaged) {
            $settings.PSObject.Properties.Remove('hooks')
            Write-Host ("  remove settings.hooks (entire block)") -ForegroundColor Yellow
        } else {
            Write-Warning "  settings.hooks contains non-harness entries -- leaving in place"
        }
    }

    if ($manifest.allowEntries -and $settings.permissions -and $settings.permissions.allow) {
        $remaining = @($settings.permissions.allow) | Where-Object { $_ -notin @($manifest.allowEntries) }
        $removed = @($settings.permissions.allow).Count - $remaining.Count
        $settings.permissions | Add-Member -NotePropertyName allow -NotePropertyValue $remaining -Force
        if ($removed -gt 0) {
            Write-Host ("  remove $removed harness permission(s) from settings.permissions.allow") -ForegroundColor Yellow
        }
    }

    $settings | ConvertTo-Json -Depth 20 | Set-Content $settingsPath -Encoding UTF8
}

# 4. Manifest cleanup --------------------------------------------------------

if (Test-Path $Manifest) {
    Remove-Item $Manifest -Force
    Write-Host ("  remove manifest $Manifest") -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Uninstalled." -ForegroundColor Cyan
Write-Host "Re-install: .\scripts\install-user.ps1"

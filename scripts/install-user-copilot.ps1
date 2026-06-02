<#
.SYNOPSIS
  Register the pair-programmer Copilot CLI plugin at user scope so /pp:* commands,
  hooks, MCP servers, agents, and skills are available in every Copilot CLI session
  for the current Windows user without copying .github into each consumer repo.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$UserCopilot = Join-Path $env:USERPROFILE '.copilot'
$Manifest = Join-Path $UserCopilot '.pp-plugin-managed.json'
$PluginName = 'pair-programmer'
$PluginListPattern = '\bpair-programmer\b'
$PluginManifestPath = Join-Path $RepoRoot 'plugin.json'
$DaemonPath = Join-Path $RepoRoot 'daemon\dist\index.js'
$SyncScript = Join-Path $RepoRoot 'scripts\sync-copilot-assets.mjs'
$HooksPath = Join-Path $RepoRoot 'hooks.json'
$OrchestratorPath = Join-Path $RepoRoot '.github\agents\pair-programmer-orchestrator.agent.md'
$DirectInstalledPluginPath = Join-Path $UserCopilot "installed-plugins\_direct\$PluginName"

function Sync-InstalledPluginCache {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SourceRoot,
        [Parameter(Mandatory = $true)]
        [string]$DestinationRoot
    )

    if (-not (Test-Path $DestinationRoot)) {
        throw "Cannot refresh in place because the installed plugin directory does not exist: $DestinationRoot"
    }

    Write-Host "Refreshing installed plugin cache in place..." -ForegroundColor Yellow
    & robocopy $SourceRoot $DestinationRoot /MIR /FFT /R:1 /W:1 /NFL /NDL /NJH /NJS /NP /XD .git .harness node_modules 2>&1 | Out-Host
    $robocopyExit = $LASTEXITCODE
    if ($robocopyExit -gt 7) {
        throw "In-place plugin refresh failed (robocopy exit code $robocopyExit)."
    }
}

if (-not (Test-Path $PluginManifestPath)) {
    throw "plugin.json not found at $PluginManifestPath. Run this script from the pair-programmer repo."
}
if (-not (Test-Path $DaemonPath)) {
    throw "Daemon not built at $DaemonPath. Build it first: cd daemon; npm install; npm run build"
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "The node CLI was not found on PATH. Install Node.js first."
}
if (-not (Get-Command copilot -ErrorAction SilentlyContinue)) {
    throw "The copilot CLI was not found on PATH. Install GitHub Copilot CLI first."
}
if (-not (Test-Path $UserCopilot)) {
    New-Item -ItemType Directory -Path $UserCopilot -Force | Out-Null
}

Write-Host ""
Write-Host "Pair-programmer Copilot plugin installer" -ForegroundColor Cyan
Write-Host "  repo:   $RepoRoot"
Write-Host "  user:   $UserCopilot"
Write-Host "  plugin: $PluginName"
Write-Host ""

# Materialize the ecosystem overlay (sibling agents/skills/squads) BEFORE the sync so
# the Copilot mirror generated from .claude includes them.
$LinkScript = Join-Path $RepoRoot 'scripts\link-ecosystem.ps1'
if (Test-Path $LinkScript) {
    Write-Host "Materializing ecosystem overlay..." -ForegroundColor Cyan
    & $LinkScript 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "Ecosystem overlay materialization failed with exit code $LASTEXITCODE."
    }
}

Write-Host "Syncing generated Copilot assets..." -ForegroundColor Cyan
& node $SyncScript 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) {
    throw "Asset sync failed with exit code $LASTEXITCODE."
}
if (-not (Test-Path $HooksPath)) {
    throw "Expected generated hooks at $HooksPath after sync, but the file was not created."
}
if (-not (Test-Path $OrchestratorPath)) {
    throw "Expected generated orchestrator agent at $OrchestratorPath after sync, but the file was not created."
}

$pluginManifest = Get-Content $PluginManifestPath -Raw | ConvertFrom-Json
$pluginAssetPaths = [ordered]@{
    agents     = $pluginManifest.agents
    skills     = $pluginManifest.skills
    commands   = $pluginManifest.commands
    hooks      = $pluginManifest.hooks
    mcpServers = $pluginManifest.mcpServers
}
foreach ($entry in $pluginAssetPaths.GetEnumerator()) {
    $assetPath = Join-Path $RepoRoot $entry.Value
    if (-not (Test-Path $assetPath)) {
        throw "plugin.json points $($entry.Key) at $assetPath, but that path does not exist."
    }
}

$listOutput = (& copilot plugin list 2>&1)
if ($LASTEXITCODE -ne 0) {
    throw "Unable to list Copilot plugins. Exit code: $LASTEXITCODE"
}

$refreshMode = 'installed'
if (($listOutput -join "`n") -match $PluginListPattern) {
    Write-Host "Removing existing pair-programmer plugin..." -ForegroundColor Cyan
    $uninstallOutput = (& copilot plugin uninstall $PluginName 2>&1)
    $uninstallOutput | Out-Host
    if ($LASTEXITCODE -ne 0) {
        $joinedUninstall = $uninstallOutput -join "`n"
        if ($joinedUninstall -match 'EBUSY' -and (Test-Path $DirectInstalledPluginPath)) {
            Write-Warning "The Copilot plugin cache is busy, so uninstall could not remove $DirectInstalledPluginPath. Falling back to an in-place refresh."
            Sync-InstalledPluginCache -SourceRoot $RepoRoot.Path -DestinationRoot $DirectInstalledPluginPath
            $refreshMode = 'refreshed-in-place'
        } else {
            throw "Failed to uninstall the existing $PluginName plugin. Exit code: $LASTEXITCODE"
        }
    }
}

if ($refreshMode -ne 'refreshed-in-place') {
    Write-Host "Installing pair-programmer plugin from the local repo..." -ForegroundColor Cyan
    $installOutput = (& copilot plugin install $RepoRoot.Path 2>&1)
    $installOutput | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "copilot plugin install failed with exit code $LASTEXITCODE."
    }
}

$verifyOutput = (& copilot plugin list 2>&1)
if ($LASTEXITCODE -ne 0) {
    throw "Unable to verify Copilot plugin registration. Exit code: $LASTEXITCODE"
}
if (($verifyOutput -join "`n") -notmatch $PluginListPattern) {
    throw "pair-programmer did not appear in `copilot plugin list` after installation."
}

$manifestPayload = [pscustomobject]@{
    version            = 2
    pluginName         = $PluginName
    installScope       = 'current-user'
    coverage           = 'all-copilot-cli-sessions'
    repoRoot           = $RepoRoot.Path
    pluginManifestPath = (Resolve-Path $PluginManifestPath).Path
    daemonPath         = (Resolve-Path $DaemonPath).Path
    hooksPath          = (Resolve-Path $HooksPath).Path
    orchestratorPath   = (Resolve-Path $OrchestratorPath).Path
    entryAgent         = 'pair-programmer-orchestrator'
    refreshMode        = $refreshMode
    installedPluginPath = if (Test-Path $DirectInstalledPluginPath) { (Resolve-Path $DirectInstalledPluginPath).Path } else { $null }
    installedAt        = (Get-Date).ToString('o')
    pluginSource       = $RepoRoot.Path
}
$manifestPayload | ConvertTo-Json -Depth 10 | Set-Content $Manifest -Encoding UTF8

Write-Host ""
if ($refreshMode -eq 'refreshed-in-place') {
    Write-Host "Done. pair-programmer is now refreshed in the existing Copilot plugin cache for the current Windows user." -ForegroundColor Cyan
} else {
    Write-Host "Done. pair-programmer is now installed for the current Windows user." -ForegroundColor Cyan
}
Write-Host "No consumer repo needs a copied .github folder; the plugin is available in every Copilot CLI session."
Write-Host ""
Write-Host "From any trusted repo, start Copilot with:" -ForegroundColor Cyan
Write-Host "  copilot --agent pair-programmer-orchestrator"
Write-Host ""
Write-Host "Then run:" -ForegroundColor Cyan
Write-Host "  /pp:doctor"
Write-Host ""
Write-Host "Re-run this installer after git pull or prompt/hook changes so Copilot refreshes the cached plugin."
Write-Host "Manifest: $Manifest"

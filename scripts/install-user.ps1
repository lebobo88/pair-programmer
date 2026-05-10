<#
.SYNOPSIS
  Register the pair-programmer harness at user scope so /pp:* commands, the 3
  MCP servers, the 25 hooks, the sub-agents, and the skills are available in
  every Claude Code session, regardless of cwd.
#>
[CmdletBinding()]
param(
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..')
$RepoClaude = Join-Path $RepoRoot '.claude'
$UserClaude = Join-Path $env:USERPROFILE '.claude'
$Manifest   = Join-Path $UserClaude '.pp-managed.json'

if (-not (Test-Path $RepoClaude)) {
    throw "Repo .claude not found at $RepoClaude. Run this script from the pair-programmer repo."
}
if (-not (Test-Path $UserClaude)) {
    New-Item -ItemType Directory -Path $UserClaude -Force | Out-Null
}

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    throw "The claude CLI was not found on PATH. Install Claude Code first."
}

Write-Host ""
Write-Host "Pair-programmer user-scope installer" -ForegroundColor Cyan
Write-Host "  repo:  $RepoRoot"
Write-Host "  user:  $UserClaude"
Write-Host ""

# 1. Junctions ----------------------------------------------------------------

$junctions = @(
    @{ Link = (Join-Path $UserClaude 'commands\pp'); Target = (Join-Path $RepoClaude 'commands\pp'); Label = 'commands/pp' },
    @{ Link = (Join-Path $UserClaude 'agents');      Target = (Join-Path $RepoClaude 'agents');      Label = 'agents/'     },
    @{ Link = (Join-Path $UserClaude 'skills');      Target = (Join-Path $RepoClaude 'skills');      Label = 'skills/'     }
)

$cmdParent = Join-Path $UserClaude 'commands'
if (-not (Test-Path $cmdParent)) { New-Item -ItemType Directory -Path $cmdParent -Force | Out-Null }

$createdLinks = @()
foreach ($j in $junctions) {
    $linkPath   = $j.Link
    $targetPath = $j.Target

    if (-not (Test-Path $targetPath)) {
        Write-Warning "  skip $($j.Label) -- target missing: $targetPath"
        continue
    }

    if (Test-Path $linkPath) {
        $item = Get-Item $linkPath -Force
        $isJunction = ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
        if ($isJunction) {
            $current = $item.Target | Select-Object -First 1
            if ($current -and ($current.TrimEnd('\') -ieq $targetPath.TrimEnd('\'))) {
                Write-Host ("  ok   {0,-16} -> {1}" -f $j.Label, $targetPath) -ForegroundColor DarkGreen
                $createdLinks += $linkPath
                continue
            }
            cmd /c rmdir "`"$linkPath`"" | Out-Null
        } elseif ($Force) {
            Write-Warning "  forcibly removing non-junction directory: $linkPath"
            Remove-Item $linkPath -Recurse -Force
        } else {
            Write-Warning "  skip $($j.Label) -- a real directory already exists at $linkPath. Re-run with -Force to replace."
            continue
        }
    }

    $cmdResult = cmd /c mklink /J "`"$linkPath`"" "`"$targetPath`"" 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "  fail $($j.Label) -- mklink: $cmdResult"
        continue
    }
    Write-Host ("  link {0,-16} -> {1}" -f $j.Label, $targetPath) -ForegroundColor Green
    $createdLinks += $linkPath
}

# 2. MCP servers via claude mcp add -s user ----------------------------------

$daemonPath = (Join-Path $RepoRoot 'daemon\dist\index.js') -replace '\\', '/'
if (-not (Test-Path $daemonPath)) {
    throw "Daemon not built at $daemonPath. Build it: cd daemon; npm install; npm run build"
}

$ppServers = @(
    @{ Name = 'pp_harness'; SubCmd = 'mcp'        },
    @{ Name = 'pp_codex';   SubCmd = 'mcp-codex'  },
    @{ Name = 'pp_gemini';  SubCmd = 'mcp-gemini' }
)

$currentList = & claude mcp list 2>&1
$registered = @()
foreach ($s in $ppServers) {
    if ($currentList -match [regex]::Escape("$($s.Name):")) {
        & claude mcp remove $s.Name -s user 2>&1 | Out-Null
    }
    & claude mcp add $s.Name -s user -- node $daemonPath $s.SubCmd 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host ("  mcp  {0,-12} -> node $daemonPath $($s.SubCmd)" -f $s.Name) -ForegroundColor Green
        $registered += $s.Name
    } else {
        Write-Warning "  fail $($s.Name) -- claude mcp add returned $LASTEXITCODE"
    }
}

# 3. Merge settings.json -----------------------------------------------------
# The committed template uses `__PP_DAEMON__` as a placeholder for the
# absolute path to daemon/dist/index.js, so the repo stays path-portable.
# Substitute it with $daemonPath before parsing JSON.

$srcSettingsPath = Join-Path $RepoClaude 'settings.template.json'
if (-not (Test-Path $srcSettingsPath)) {
    # Fall back to settings.json for forward-compat with checkouts predating the template split.
    $srcSettingsPath = Join-Path $RepoClaude 'settings.json'
}
$dstSettingsPath = Join-Path $UserClaude 'settings.json'

$srcRaw      = Get-Content $srcSettingsPath -Raw
$srcRendered = $srcRaw -replace '__PP_DAEMON__', $daemonPath
$srcSettings = $srcRendered | ConvertFrom-Json
$dstSettings = if (Test-Path $dstSettingsPath) {
    Get-Content $dstSettingsPath -Raw | ConvertFrom-Json
} else {
    [pscustomobject]@{}
}

# Also render a local copy at <repo>/.claude/settings.json so the repo
# functions as a project-scope Claude Code project for harness developers.
# This file is gitignored.
$localRenderedPath = Join-Path $RepoClaude 'settings.json'
$srcRendered | Set-Content $localRenderedPath -Encoding UTF8

$dstSettings | Add-Member -NotePropertyName hooks -NotePropertyValue $srcSettings.hooks -Force

if (-not $dstSettings.PSObject.Properties.Match('permissions')) {
    $dstSettings | Add-Member -NotePropertyName permissions -NotePropertyValue ([pscustomobject]@{ allow = @(); deny = @(); ask = @() }) -Force
}
$existingAllow = @()
if ($dstSettings.permissions.PSObject.Properties.Match('allow')) {
    $existingAllow = @($dstSettings.permissions.allow)
}
$srcAllow = @($srcSettings.permissions.allow)
$mergedAllow = ($existingAllow + $srcAllow) | Where-Object { $_ } | Select-Object -Unique
$dstSettings.permissions | Add-Member -NotePropertyName allow -NotePropertyValue $mergedAllow -Force

$dstSettings | ConvertTo-Json -Depth 20 | Set-Content $dstSettingsPath -Encoding UTF8

$hookCount = 0
foreach ($p in $srcSettings.hooks.PSObject.Properties) { $hookCount += @($p.Value).Count }
$eventCount = @($srcSettings.hooks.PSObject.Properties).Count
$allowAdded = ($srcAllow | Where-Object { $_ -notin $existingAllow }).Count
Write-Host ("  merge settings.json -> {0} hook(s) across {1} event(s); +{2} permission(s)" -f $hookCount, $eventCount, $allowAdded) -ForegroundColor Green

# 4. Manifest ----------------------------------------------------------------

$manifestPayload = [pscustomobject]@{
    version       = 2
    repoRoot      = $RepoRoot.Path
    daemonPath    = $daemonPath
    installedAt   = (Get-Date).ToString('o')
    junctions     = $createdLinks
    mcpServers    = $registered
    hookEventKeys = @($srcSettings.hooks.PSObject.Properties.Name)
    allowEntries  = $srcAllow
}
$manifestPayload | ConvertTo-Json -Depth 10 | Set-Content $Manifest -Encoding UTF8

Write-Host ""
Write-Host "Verifying MCP registration..." -ForegroundColor Cyan
$listOut = & claude mcp list 2>&1
foreach ($s in $registered) {
    $line = $listOut | Where-Object { $_ -match "^$s\b" }
    if ($line) {
        Write-Host "  $line"
    } else {
        Write-Warning "  $s missing from claude mcp list output"
    }
}

Write-Host ""
Write-Host "Done. Open a FRESH Claude Code session in any folder:" -ForegroundColor Cyan
Write-Host "  cd <any project>"
Write-Host "  claude   # then type /pp:doctor"
Write-Host ""
Write-Host "Manifest: $Manifest"

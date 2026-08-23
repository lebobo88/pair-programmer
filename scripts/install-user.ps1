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

function Install-LinkItem {
    param(
        [Parameter(Mandatory = $true)][string]$LinkPath,
        [Parameter(Mandatory = $true)][string]$TargetPath,
        [Parameter(Mandatory = $true)][string]$Label,
        [switch]$IsDirectory
    )
    if (-not (Test-Path $TargetPath)) {
        Write-Warning "  skip $Label -- target missing: $TargetPath"
        return $null
    }
    $parentDir = Split-Path -Parent $LinkPath
    if (-not (Test-Path $parentDir)) {
        New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
    }
    if (Test-Path $LinkPath) {
        $item = Get-Item $LinkPath -Force
        $isReparse = ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
        if ($isReparse) {
            $current = $item.Target | Select-Object -First 1
            if ($current -and (($current -replace '\\','/').TrimEnd('/') -ieq ($TargetPath -replace '\\','/').TrimEnd('/'))) {
                Write-Host ("  ok   {0,-38} -> {1}" -f $Label, $TargetPath) -ForegroundColor DarkGreen
                return $LinkPath
            }
            if ($item.PSIsContainer) {
                cmd /c rmdir "`"$LinkPath`"" 2>$null | Out-Null
            } else {
                Remove-Item $LinkPath -Force
            }
        } elseif ($Force) {
            Write-Warning "  forcibly removing non-link item: $LinkPath"
            Remove-Item $LinkPath -Recurse -Force
        } else {
            Write-Warning "  skip $Label -- a real file/directory already exists at $LinkPath. Re-run with -Force to replace."
            return $null
        }
    }
    if ($IsDirectory) {
        $cmdResult = cmd /c mklink /J "`"$LinkPath`"" "`"$TargetPath`"" 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host ("  link {0,-38} -> {1}" -f $Label, $TargetPath) -ForegroundColor Green
            return $LinkPath
        }
        try {
            New-Item -ItemType SymbolicLink -Path $LinkPath -Target $TargetPath -ErrorAction Stop | Out-Null
            Write-Host ("  link {0,-38} -> {1}" -f $Label, $TargetPath) -ForegroundColor Green
            return $LinkPath
        } catch {
            Write-Warning "  fail $Label -- $cmdResult | $_"
            return $null
        }
    } else {
        try {
            New-Item -ItemType SymbolicLink -Path $LinkPath -Target $TargetPath -ErrorAction Stop | Out-Null
            Write-Host ("  link {0,-38} -> {1}" -f $Label, $TargetPath) -ForegroundColor Green
            return $LinkPath
        } catch {
            try {
                New-Item -ItemType HardLink -Path $LinkPath -Target $TargetPath -ErrorAction Stop | Out-Null
                Write-Host ("  hlink {0,-37} -> {1}" -f $Label, $TargetPath) -ForegroundColor Green
                return $LinkPath
            } catch {
                Copy-Item -Path $TargetPath -Destination $LinkPath -Force
                Write-Host ("  copy {0,-38} -> {1}" -f $Label, $TargetPath) -ForegroundColor Yellow
                return $LinkPath
            }
        }
    }
}

# 1. Assets Linking -----------------------------------------------------------

$createdLinks = @()

# 1a. Commands (pp)
$ppCmdLink = Install-LinkItem -LinkPath (Join-Path $UserClaude 'commands\pp') -TargetPath (Join-Path $RepoClaude 'commands\pp') -Label 'commands/pp' -IsDirectory
if ($ppCmdLink) { $createdLinks += $ppCmdLink }

# 1b. Agents, Skills, Teams, Rubrics, Profiles, Gotchas, Prompt-Addenda
$assetDirs = @('agents', 'skills', 'teams', 'rubrics', 'profiles', 'gotchas', 'prompt-addenda')
foreach ($subDir in $assetDirs) {
    $srcDir = Join-Path $RepoClaude $subDir
    $dstDir = Join-Path $UserClaude $subDir
    if (-not (Test-Path $srcDir)) { continue }
    if (-not (Test-Path $dstDir)) { New-Item -ItemType Directory -Path $dstDir -Force | Out-Null }

    foreach ($item in (Get-ChildItem -Path $srcDir -Force -ErrorAction SilentlyContinue)) {
        $link = Join-Path $dstDir $item.Name
        $label = "$subDir/$($item.Name)"
        $res = Install-LinkItem -LinkPath $link -TargetPath $item.FullName -Label $label -IsDirectory:$item.PSIsContainer
        if ($res) { $createdLinks += $res }
    }
}

# 2. MCP servers via claude mcp add -s user ----------------------------------

$daemonPath = (Join-Path $RepoRoot 'daemon\dist\index.js') -replace '\\', '/'
if (-not (Test-Path $daemonPath)) {
    throw "Daemon not built at $daemonPath. Build it: cd daemon; npm install; npm run build"
}

$ppServers = @(
    @{ Name = 'pp_harness'; SubCmd = 'mcp'        },
    @{ Name = 'pp_codex';   SubCmd = 'mcp-codex'  },
    @{ Name = 'pp_agy';     SubCmd = 'mcp-agy'    }
)

$registered = @()
foreach ($s in $ppServers) {
    try {
        & claude mcp remove $s.Name -s user 2>$null | Out-Null
    } catch {}
    try {
        & claude mcp add $s.Name -s user -- node $daemonPath $s.SubCmd 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-Host ("  mcp  {0,-12} -> node $daemonPath $($s.SubCmd)" -f $s.Name) -ForegroundColor Green
            $registered += $s.Name
        } else {
            Write-Warning "  fail $($s.Name) -- claude mcp add returned $LASTEXITCODE"
        }
    } catch {
        Write-Warning "  fail $($s.Name) -- $_"
    }
}

# 3. Merge settings.json -----------------------------------------------------
# The committed template uses `__PP_DAEMON__` as a placeholder so the repo
# stays path-portable.  There are TWO render variants:
#
#   (a) USER scope  (~/.claude/settings.json)
#       __PP_DAEMON__ -> $daemonPath  (absolute, machine-specific)
#       Hooks fire in every project where $CLAUDE_PROJECT_DIR is NOT the
#       pair-programmer repo, so the path must be absolute.
#
#   (b) PROJECT scope  (<repo>/.claude/settings.json, git-ignored)
#       __PP_DAEMON__ -> $CLAUDE_PROJECT_DIR/daemon/dist/index.js  (literal)
#       Claude Code expands $CLAUDE_PROJECT_DIR at hook-execution time, so the
#       project-local file is identical on every machine and self-relocating.
#       The literal dollar-sign is emitted as-is; PowerShell must NOT expand it.

$srcSettingsPath = Join-Path $RepoClaude 'settings.template.json'
if (-not (Test-Path $srcSettingsPath)) {
    # Fall back to settings.json for forward-compat with checkouts predating the template split.
    $srcSettingsPath = Join-Path $RepoClaude 'settings.json'
}
$dstSettingsPath = Join-Path $UserClaude 'settings.json'

$srcRaw      = Get-Content $srcSettingsPath -Raw

# (a) USER-scope render: absolute path so hooks work in every project.
$srcRendered = $srcRaw -replace '__PP_DAEMON__', $daemonPath
$srcSettings = $srcRendered | ConvertFrom-Json
$dstSettings = if (Test-Path $dstSettingsPath) {
    Get-Content $dstSettingsPath -Raw | ConvertFrom-Json
} else {
    [pscustomobject]@{}
}

# (b) PROJECT-scope render: self-relocating literal so the file is
# machine-independent.  Use a single-quoted replacement string so PowerShell
# passes the dollar-sign through verbatim (no variable expansion).
$localRendered    = $srcRaw -replace '__PP_DAEMON__', '$CLAUDE_PROJECT_DIR/daemon/dist/index.js'
$localRenderedPath = Join-Path $RepoClaude 'settings.json'
$localRendered | Set-Content $localRenderedPath -Encoding UTF8

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
    links         = $createdLinks
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

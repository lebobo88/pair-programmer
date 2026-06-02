#requires -Version 7
<#
.SYNOPSIS
  Materialize sibling-project (ecosystem) agents/skills/squads into pair-programmer's
  per-machine overlay — dynamically, with no absolute paths committed to git.

.DESCRIPTION
  Mirrors AgentSmith's install-user-scope.ps1 linking mechanics (Test-SymlinkCapability
  probe -> New-Item -ItemType SymbolicLink preferred, Copy-Item fallback) but links the
  OTHER direction: from each sibling repo INTO this clone's .claude/agents, .claude/skills,
  and squads/.

  Sibling roots resolve dynamically (see daemon/src/util/paths.ts consumerBase()):
    PP_CONSUMER_BASE  ->  PP_ECOSYSTEM_ROOT  ->  parent folder of this clone.
  The sibling NAME list is the neutral manifest .harness/ecosystem.json (shared with the
  daemon and sync-copilot-assets.mjs — never parse the .ts module from here).

  Idempotent. Native pp artifacts always win (a real, git-tracked file/dir is never
  overwritten). Degraded "stub" files (the core.symlinks=false checkout artifact) are
  replaced. A per-machine run manifest .harness/.ecosystem-links.local.json records every
  managed link for idempotency, -Prune, and doctor.

.PARAMETER DryRun
  Print what would happen; change nothing.

.PARAMETER Prune
  Remove managed links recorded in the prior run manifest that are no longer produced by
  the current scan (e.g. a sibling was removed from the manifest or deleted an artifact).

.PARAMETER Force
  Replace a real, non-stub target even when it is not a recognized managed link. Use with
  care — this is the only way to clobber something that looks native.

.PARAMETER ConsumerBase
  Explicit ecosystem base override (highest priority; beats the env vars).
#>
[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$Prune,
  [switch]$Force,
  [string]$ConsumerBase
)

$ErrorActionPreference = "Stop"

$RepoRoot = ((Resolve-Path (Join-Path $PSScriptRoot "..")).Path -replace '\\','/').TrimEnd('/')
$ManifestPath = Join-Path $RepoRoot ".harness/ecosystem.json"
$RunManifestPath = Join-Path $RepoRoot ".harness/.ecosystem-links.local.json"

function Write-Eco($msg, $level = "info") {
  $prefix = "[link-ecosystem]"
  switch ($level) {
    "warn"  { Write-Host "$prefix $msg" -ForegroundColor Yellow }
    "error" { Write-Host "$prefix $msg" -ForegroundColor Red }
    "ok"    { Write-Host "$prefix $msg" -ForegroundColor Green }
    "skip"  { Write-Host "$prefix $msg" -ForegroundColor DarkGray }
    default { Write-Host "$prefix $msg" }
  }
}

# --- Resolve the ecosystem consumer base (mirror consumerBase() in paths.ts) ---
function Resolve-ConsumerBase {
  if ($ConsumerBase) { return ($ConsumerBase -replace '\\','/').TrimEnd('/') }
  $envBase = if ($env:PP_CONSUMER_BASE) { $env:PP_CONSUMER_BASE } elseif ($env:PP_ECOSYSTEM_ROOT) { $env:PP_ECOSYSTEM_ROOT } else { $null }
  if ($envBase) { return ($envBase -replace '\\','/').TrimEnd('/') }
  # Default: parent folder of this clone (siblings live adjacent).
  return (Split-Path -Parent $RepoRoot) -replace '\\','/'
}

# --- Symlink capability probe (verbatim from AgentSmith) ---
function Test-SymlinkCapability {
  $probeDir = Join-Path $env:TEMP "pp-symlink-probe"
  $probeTarget = Join-Path $probeDir "target.txt"
  $probeLink = Join-Path $probeDir "link.txt"
  try {
    New-Item -ItemType Directory -Path $probeDir -Force | Out-Null
    "ok" | Out-File -FilePath $probeTarget -Encoding utf8
    if (Test-Path $probeLink) { Remove-Item $probeLink -Force }
    New-Item -ItemType SymbolicLink -Path $probeLink -Target $probeTarget -ErrorAction Stop | Out-Null
    return $true
  } catch {
    return $false
  } finally {
    if (Test-Path $probeDir) { Remove-Item $probeDir -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

# A target is a degraded "stub" if it is a small regular file whose content is a single
# path-like line (the artifact of checking out a 120000 symlink with core.symlinks=false).
function Test-IsStub([string]$Path) {
  try {
    $item = Get-Item $Path -Force -ErrorAction Stop
    if ($item.PSIsContainer) { return $false }
    if ($item.LinkType) { return $false }      # real reparse point, not a stub
    if ($item.Length -gt 512) { return $false }
    $raw = (Get-Content $Path -Raw -ErrorAction Stop)
    $trimmed = $raw.Trim()
    if (-not $trimmed) { return $false }
    if ($trimmed -match "`n") { return $false } # more than one line => real content
    return ($trimmed -match '[\\/]')            # looks like a path
  } catch { return $false }
}

function Test-IsGitTracked([string]$Path) {
  try {
    & git -C $RepoRoot ls-files --error-unmatch -- $Path 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
  } catch { return $false }
}

$script:CanSymlink = Test-SymlinkCapability
$script:Managed = [System.Collections.Generic.List[object]]::new()

# Returns "symlink" | "copy" | "ok" | "skip-native" | "dryrun"
function Link-One([string]$Source, [string]$Target, [string]$Kind, [string]$Name) {
  $rel = ($Target -replace [regex]::Escape($RepoRoot), '').TrimStart('/','\')
  $isDir = (Get-Item $Source -Force).PSIsContainer

  if (Test-Path $Target) {
    $item = Get-Item $Target -Force
    if ($item.LinkType) {
      # Already a reparse point. If it points where we want, leave it.
      $curTarget = ($item.Target -replace '\\','/')
      $wantTarget = ($Source -replace '\\','/')
      if ($curTarget -and ($curTarget.TrimEnd('/') -ieq $wantTarget.TrimEnd('/'))) {
        $script:Managed.Add(@{ kind=$Kind; name=$Name; link=$rel; target=$Source; strategy="symlink" })
        Write-Eco "ok    $Kind/$Name" "ok"; return "ok"
      }
      # Reparse point but stale target -> replace.
    }
    elseif (Test-IsStub $Target) {
      # Degraded core.symlinks=false stub -> replace.
    }
    elseif (Test-IsGitTracked $Target) {
      Write-Eco "skip  $Kind/$Name -- native git-tracked artifact (not overwritten)" "skip"
      return "skip-native"
    }
    elseif (-not $Force) {
      # Real, untracked, non-stub, not previously managed: be conservative.
      Write-Eco "skip  $Kind/$Name -- existing untracked file (use -Force to replace)" "skip"
      return "skip-native"
    }
    if ($DryRun) { Write-Eco "would replace $Kind/$Name -> $Source"; return "dryrun" }
    Remove-Item $Target -Recurse -Force
  }
  if ($DryRun) { Write-Eco "would link $Kind/$Name -> $Source"; return "dryrun" }

  $parent = Split-Path -Parent $Target
  if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }

  if ($script:CanSymlink) {
    try {
      New-Item -ItemType SymbolicLink -Path $Target -Target $Source -ErrorAction Stop | Out-Null
      $script:Managed.Add(@{ kind=$Kind; name=$Name; link=$rel; target=$Source; strategy="symlink" })
      Write-Eco "link  $Kind/$Name" "ok"; return "symlink"
    } catch {
      Write-Eco "symlink failed for $Kind/$Name — copying instead: $_" "warn"
    }
  }
  if ($isDir) { Copy-Item -Path $Source -Destination $Target -Recurse -Force }
  else        { Copy-Item -Path $Source -Destination $Target -Force }
  $script:Managed.Add(@{ kind=$Kind; name=$Name; link=$rel; target=$Source; strategy="copy" })
  Write-Eco "copy  $Kind/$Name (edits won't propagate until re-run)" "warn"; return "copy"
}

# --- Main ---
if (-not (Test-Path $ManifestPath)) { throw "ecosystem manifest not found: $ManifestPath" }
$siblings = (Get-Content $ManifestPath -Raw | ConvertFrom-Json).siblings
$base = Resolve-ConsumerBase

Write-Eco "repo:          $RepoRoot"
Write-Eco "consumer base: $base"
Write-Eco "siblings:      $($siblings -join ', ')"
Write-Eco "symlink capable: $script:CanSymlink $(if (-not $script:CanSymlink) { '(enable Developer Mode for real links instead of copies)' })"
Write-Eco ""

$desiredRel = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)

foreach ($sib in $siblings) {
  $sibRoot = (Join-Path $base $sib) -replace '\\','/'
  if (-not (Test-Path $sibRoot)) { Write-Eco "skip sibling '$sib' -- not found at $sibRoot" "warn"; continue }
  Write-Eco "sibling: $sib  ($sibRoot)"

  # agents: per-FILE (.md)
  $agentsDir = Join-Path $sibRoot ".claude/agents"
  if (Test-Path $agentsDir) {
    foreach ($f in Get-ChildItem $agentsDir -Filter *.md -File) {
      $target = Join-Path $RepoRoot ".claude/agents/$($f.Name)"
      Link-One $f.FullName $target "agent" ($f.BaseName) | Out-Null
      $desiredRel.Add((".claude/agents/$($f.Name)")) | Out-Null
    }
  }
  # skills: per-ENTRY (directories, sometimes .md)
  $skillsDir = Join-Path $sibRoot ".claude/skills"
  if (Test-Path $skillsDir) {
    foreach ($e in Get-ChildItem $skillsDir) {
      $target = Join-Path $RepoRoot ".claude/skills/$($e.Name)"
      Link-One $e.FullName $target "skill" ($e.Name) | Out-Null
      $desiredRel.Add((".claude/skills/$($e.Name)")) | Out-Null
    }
  }
  # squads: per-DIRECTORY
  $squadsDir = Join-Path $sibRoot "squads"
  if (Test-Path $squadsDir) {
    foreach ($e in Get-ChildItem $squadsDir -Directory) {
      $target = Join-Path $RepoRoot "squads/$($e.Name)"
      Link-One $e.FullName $target "squad" ($e.Name) | Out-Null
      $desiredRel.Add(("squads/$($e.Name)")) | Out-Null
    }
  }
}

# --- Prune managed links no longer desired ---
if ($Prune -and (Test-Path $RunManifestPath)) {
  $prior = (Get-Content $RunManifestPath -Raw | ConvertFrom-Json).links
  foreach ($p in $prior) {
    if (-not $desiredRel.Contains($p.link)) {
      $abs = Join-Path $RepoRoot $p.link
      if (Test-Path $abs) {
        if ($DryRun) { Write-Eco "would prune $($p.kind)/$($p.name)" }
        else { Remove-Item $abs -Recurse -Force; Write-Eco "prune $($p.kind)/$($p.name)" "warn" }
      }
    }
  }
}

# --- Write run manifest (gitignored) ---
if (-not $DryRun) {
  $payload = [pscustomobject]@{
    schemaVersion = 1
    generatedAt   = (Get-Date).ToString("o")
    repoRoot      = $RepoRoot
    consumerBase  = $base
    symlinkCapable = $script:CanSymlink
    links         = $script:Managed
  }
  $payload | ConvertTo-Json -Depth 8 | Set-Content $RunManifestPath -Encoding UTF8
}

$nCopy = ($script:Managed | Where-Object { $_.strategy -eq "copy" }).Count
Write-Eco ""
Write-Eco "done: $($script:Managed.Count) managed link(s)$(if ($nCopy) { ", $nCopy as copies (no Developer Mode)" })" "ok"

#!/usr/bin/env bash
# Materialize sibling-project (ecosystem) agents/skills/squads into pair-programmer's
# per-machine overlay — POSIX parity of scripts/link-ecosystem.ps1.
#
# Sibling roots resolve dynamically: PP_CONSUMER_BASE -> PP_ECOSYSTEM_ROOT -> parent of
# this clone. Sibling NAME list comes from the neutral manifest .harness/ecosystem.json.
# POSIX symlinks always work, so there is no capability-probe / copy fallback here.
#
# Usage: scripts/link-ecosystem.sh [--prune] [--force] [--dry-run]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MANIFEST="$REPO_ROOT/.harness/ecosystem.json"
RUN_MANIFEST="$REPO_ROOT/.harness/.ecosystem-links.local.json"

DRYRUN=0; FORCE=0; PRUNE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRYRUN=1 ;;
    --force)   FORCE=1 ;;
    --prune)   PRUNE=1 ;;
    *) echo "[link-ecosystem] unknown arg: $arg" >&2; exit 2 ;;
  esac
done

log() { echo "[link-ecosystem] $*"; }

[ -f "$MANIFEST" ] || { echo "[link-ecosystem] manifest not found: $MANIFEST" >&2; exit 1; }

# Resolve consumer base (mirror consumerBase() in paths.ts).
if [ -n "${PP_CONSUMER_BASE:-}" ]; then BASE="$PP_CONSUMER_BASE"
elif [ -n "${PP_ECOSYSTEM_ROOT:-}" ]; then BASE="$PP_ECOSYSTEM_ROOT"
else BASE="$(dirname "$REPO_ROOT")"; fi

# Siblings list via node (guaranteed present in this ecosystem).
SIBLINGS="$(node -e "process.stdout.write((JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).siblings||[]).join('\n'))" "$MANIFEST")"

log "repo:          $REPO_ROOT"
log "consumer base: $BASE"
log "siblings:      $(echo "$SIBLINGS" | tr '\n' ' ')"

# Is a path a degraded core.symlinks=false stub? (small single-line path-like file)
is_stub() {
  local p="$1"
  [ -f "$p" ] && [ ! -L "$p" ] || return 1
  [ "$(wc -c < "$p")" -le 512 ] || return 1
  [ "$(wc -l < "$p")" -le 1 ] || return 1
  grep -q '[\\/]' "$p" 2>/dev/null
}

MANIFEST_LINES=""
link_one() { # src target kind name relpath
  local src="$1" target="$2" kind="$3" name="$4" rel="$5"
  if [ -L "$target" ]; then
    if [ "$(readlink "$target")" = "$src" ]; then
      log "ok    $kind/$name"; MANIFEST_LINES+="$rel|$kind|$name|symlink\n"; return
    fi
  elif [ -e "$target" ]; then
    if is_stub "$target"; then :  # degraded stub -> replace
    elif git -C "$REPO_ROOT" ls-files --error-unmatch -- "$target" >/dev/null 2>&1; then
      log "skip  $kind/$name -- native git-tracked artifact"; return
    elif [ "$FORCE" -ne 1 ]; then
      log "skip  $kind/$name -- existing untracked file (use --force)"; return
    fi
  fi
  if [ "$DRYRUN" -eq 1 ]; then log "would link $kind/$name -> $src"; return; fi
  mkdir -p "$(dirname "$target")"
  rm -rf "$target"
  ln -s "$src" "$target"
  log "link  $kind/$name"; MANIFEST_LINES+="$rel|$kind|$name|symlink\n"
}

DESIRED=""
while IFS= read -r sib; do
  [ -n "$sib" ] || continue
  sib_root="$BASE/$sib"
  if [ ! -d "$sib_root" ]; then log "skip sibling '$sib' -- not found at $sib_root"; continue; fi
  log "sibling: $sib ($sib_root)"
  # agents (files)
  if [ -d "$sib_root/.claude/agents" ]; then
    for f in "$sib_root/.claude/agents"/*.md; do
      [ -e "$f" ] || continue
      bn="$(basename "$f")"; link_one "$f" "$REPO_ROOT/.claude/agents/$bn" agent "${bn%.md}" ".claude/agents/$bn"
      DESIRED+=".claude/agents/$bn\n"
    done
  fi
  # skills (entries)
  if [ -d "$sib_root/.claude/skills" ]; then
    for e in "$sib_root/.claude/skills"/*; do
      [ -e "$e" ] || continue
      bn="$(basename "$e")"; link_one "$e" "$REPO_ROOT/.claude/skills/$bn" skill "$bn" ".claude/skills/$bn"
      DESIRED+=".claude/skills/$bn\n"
    done
  fi
  # squads (dirs)
  if [ -d "$sib_root/squads" ]; then
    for e in "$sib_root/squads"/*/; do
      [ -d "$e" ] || continue
      bn="$(basename "$e")"; link_one "${e%/}" "$REPO_ROOT/squads/$bn" squad "$bn" "squads/$bn"
      DESIRED+="squads/$bn\n"
    done
  fi
done <<< "$SIBLINGS"

# Prune
if [ "$PRUNE" -eq 1 ] && [ -f "$RUN_MANIFEST" ]; then
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    if ! printf '%b' "$DESIRED" | grep -qxF "$rel"; then
      if [ "$DRYRUN" -eq 1 ]; then log "would prune $rel"; else rm -rf "${REPO_ROOT:?}/$rel"; log "prune $rel"; fi
    fi
  done < <(node -e "try{const m=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));(m.links||[]).forEach(l=>console.log(l.link))}catch(e){}" "$RUN_MANIFEST")
fi

# Write run manifest (gitignored)
if [ "$DRYRUN" -ne 1 ]; then
  printf '%b' "$MANIFEST_LINES" | node -e '
    const fs=require("fs");const lines=fs.readFileSync(0,"utf8").trim().split("\n").filter(Boolean);
    const links=lines.map(l=>{const[link,kind,name,strategy]=l.split("|");return{link,kind,name,strategy}});
    fs.writeFileSync(process.argv[1],JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),repoRoot:process.argv[2],consumerBase:process.argv[3],symlinkCapable:true,links},null,2));
  ' "$RUN_MANIFEST" "$REPO_ROOT" "$BASE"
fi

log "done."

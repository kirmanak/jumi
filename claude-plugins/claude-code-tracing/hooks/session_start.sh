#!/bin/bash
# SessionStart - Initialize session state
source "$(dirname "$0")/common.sh"

check_requirements

input=$(cat 2>/dev/null || echo '{}')
[[ -z "$input" ]] && input='{}'

resolve_session "$input"
ensure_session_initialized "$input"

# Jumi: every run starts here, so this is the one place a state file left by a
# killed child (timeout, quota abort, SIGTERM) is guaranteed to be swept.
gc_stale_state_files

log "Session started: $(get_state 'session_id')"

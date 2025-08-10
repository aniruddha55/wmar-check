#!/bin/bash
set -euo pipefail
cd /Users/aniruddha.basak/Projects/wmar-check

# secrets
source "$HOME/.wmar_env"

# local, headed, chromium (this matched your working setup)
export HEAD=1
export SLOW_FLOW_MS=200
export VERIFY_MS=3000
export PAUSE_BEFORE_YEAR_MS=1500
export PAUSE_AFTER_YEAR_MS=1500
export RESULT_SHOT=1
export STATE_PATH=".wmar_state.json"

# absolute node path so launchd finds it
/opt/homebrew/bin/node wmar.js

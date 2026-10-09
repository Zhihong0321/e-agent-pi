#!/usr/bin/env bash
# Usage: ssh.sh <script.mjs> [base64-json-arg]
# Runs a local .mjs inside the prod container (/app, so 'pg' and server/ resolve) and prints its stdout.
set -eu
script="$1"
arg="${2:-e30=}"
b64=$(base64 -w0 "$script")
name=".mt-$$-$RANDOM.mjs"
railway ssh --service "E Agent (PI)" -- sh -c "cd /app && echo $b64 | base64 -d > $name && node $name '$arg'; rc=\$?; rm -f $name; exit \$rc"

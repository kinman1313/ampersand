#!/usr/bin/env sh
# Runs the agent edge function against a fake database and a fake Claude API,
# covering the success path and every I/O failure path. Needs Node 20+.
set -e
cd "$(dirname "$0")"
mkdir -p .build
sed 's|import { createClient } from "jsr:@supabase/supabase-js@2";|const createClient = (...a) => (globalThis as any).__stub.createClient(...a);|' \
  ../supabase/functions/agent/index.ts > .build/agent.ts
npx -y esbuild@0.24.0 .build/agent.ts --outfile=.build/agent.mjs --log-level=warning
node agent-harness.mjs

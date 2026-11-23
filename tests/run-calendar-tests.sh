#!/usr/bin/env sh
# Runs the calendar and calendar-callback edge functions, the agent's calendar check and the shared calendar
# module against a fake database and fake Google, Microsoft and Claude APIs. Needs Node 20+.
set -e
cd "$(dirname "$0")"
mkdir -p .build
stub='s|import { createClient } from "jsr:@supabase/supabase-js@2";|const createClient = (...a) => (globalThis as any).__stub.createClient(...a);|'
shared='s|"\.\./_shared/calendar\.ts"|"../../supabase/functions/_shared/calendar.ts"|'
for fn in calendar calendar-callback; do
  sed -e "$stub" -e "$shared" "../supabase/functions/$fn/index.ts" > ".build/$fn.ts"
  npx -y esbuild@0.24.0 ".build/$fn.ts" --bundle --format=esm --outfile=".build/$fn.mjs" --log-level=warning
done
sed -e "$stub" -e "$shared" ../supabase/functions/agent/index.ts > .build/agent-cal.ts
npx -y esbuild@0.24.0 .build/agent-cal.ts --bundle --format=esm --outfile=.build/agent-cal.mjs --log-level=warning
npx -y esbuild@0.24.0 ../supabase/functions/_shared/calendar.ts --bundle --format=esm --outfile=.build/calendar-lib.mjs --log-level=warning
node calendar-harness.mjs

#!/usr/bin/env sh
# Runs the notify edge function against a fake database, fake auth admin and a fake Resend API,
# covering every send, skip and failure path. Needs Node 20+.
set -e
cd "$(dirname "$0")"
mkdir -p .build
sed 's|import { createClient } from "jsr:@supabase/supabase-js@2";|const createClient = (...a) => (globalThis as any).__stub.createClient(...a);|' \
  ../supabase/functions/notify/index.ts > .build/notify.ts
npx -y esbuild@0.24.0 .build/notify.ts --outfile=.build/notify.mjs --log-level=warning
node notify-harness.mjs

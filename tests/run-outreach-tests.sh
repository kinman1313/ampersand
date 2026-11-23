#!/usr/bin/env sh
# Runs the outreach and outreach-inbound edge functions against a fake database, fake auth admin,
# fake Claude API and fake Resend API. Needs Node 20+.
set -e
cd "$(dirname "$0")"
mkdir -p .build
sed -e 's|import { createClient } from "jsr:@supabase/supabase-js@2";|const createClient = (...a) => (globalThis as any).__stub.createClient(...a);|' \
    -e 's|\.\./_shared/calendar\.ts|../../supabase/functions/_shared/calendar.ts|' \
  ../supabase/functions/outreach/index.ts > .build/outreach.ts
sed 's|import { createClient } from "jsr:@supabase/supabase-js@2";|const createClient = (...a) => (globalThis as any).__stub.createClient(...a);|' \
  ../supabase/functions/outreach-inbound/index.ts > .build/outreach-inbound.ts
npx -y esbuild@0.24.0 .build/outreach.ts --bundle --format=esm --outfile=.build/outreach.mjs --log-level=warning
npx -y esbuild@0.24.0 .build/outreach-inbound.ts --bundle --format=esm --outfile=.build/outreach-inbound.mjs --log-level=warning
node outreach-harness.mjs

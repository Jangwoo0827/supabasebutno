# @supabasebutno/client

JavaScript / TypeScript client for [supabasebutno](../../README.md): database, auth, storage and realtime.
No dependencies. Runs in browsers, Node 22+ and browser extensions.

```ts
import { createClient } from '@supabasebutno/client';

const client = createClient('http://localhost:8787', ANON_KEY);

const { data, error } = await client.from('todos').select('*').eq('done', false);
await client.auth.signUp({ email, password });
await client.storage.from('avatars').upload('me.png', file);
client.channel('board').on('postgres_changes', { event: '*', table: 'scores' }, console.log).subscribe();
```

Full guide (options, errors, session handling, extensions, differences from supabase-js, security notes):
[SDK section of the main README](../../README.md#클라이언트-sdk-phase-6).

## Build and test

```bash
npm run build -w @supabasebutno/client   # dist/: index.js (ESM), index.cjs, index.global.js, index.global.min.js (<script>), types/
npm test -w @supabasebutno/client        # builds, then runs the tests against a real in-process server
```

Tests start the real server (HTTP + WebSocket) from `packages/server`, and also load the built browser bundle in a
script-only context (`node:vm`, no module system) to prove it works from a plain `<script>` tag.

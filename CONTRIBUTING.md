# Contributing

Thanks for helping! FreeTheWebcam is a self-hosted, white-label live streaming platform.

## Getting started

```bash
npm install
npm test          # embedded PostgreSQL, no services needed
npm run demo      # full local demo (needs the livekit-server binary)
```

## Guidelines

- **TypeScript runs directly on Node 22** (type stripping): use `.ts` import extensions and erasable syntax only
  (no enums, no parameter properties). Run `npm run typecheck` before opening a pull request.
- **Every change comes with tests.** Money, access control and compliance code must be covered.
- **Money goes through the ledger** (`src/ledger/ledger.ts`): every transaction must balance to zero and be idempotent.
- **Escape everything.** Use the `html` template tag (`src/web/html.ts`); never build HTML with string concatenation.
  In the browser, use `textContent`, never `innerHTML` with user data.
- **No external requests from the browser** (fonts, CDNs, analytics). The Content-Security-Policy blocks them.
- **Providers** live in `src/providers/adapters`. A new provider needs a manifest entry, an adapter, a test-mode path
  and tests based on the provider's official documentation (link it in a comment).
- Keep the UI copy short and clear (English). Translations are welcome.

## Pull requests

1. Fork and create a branch from `main`.
2. Make your change with tests.
3. `npm run typecheck && npm test`
4. Describe what changed and why.

By contributing you agree that your contributions are licensed under the AGPL-3.0.

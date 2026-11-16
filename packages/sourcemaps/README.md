# @tracexpro/sourcemaps

Uploads your build's source maps to TraceX, so errors show your original files, lines
and functions instead of minified code.

```bash
TRACEX_UPLOAD_TOKEN=txs_… npx @tracexpro/sourcemaps upload ./dist --release "$GIT_SHA" --delete-after
```

- `--release` must match `release` in `TraceX.init`.
- The upload token (`txs_…`) is secret: create it under TraceX → Issues → Alerts and SDK →
  Source maps and keep it in your CI's secrets. The public `txp_pub_` key can't upload.
- `--delete-after` removes the `.map` files once uploaded, so they aren't deployed.
- Next.js: `upload .next/static --url-prefix _next/static`.

Docs: https://docs.tracexpro.com/errors/source-maps/

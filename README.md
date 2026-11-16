# TraceX SDKs

Error tracking for [TraceX](https://tracexpro.com): errors from your apps grouped into
issues, alerts in Slack and email, and root causes TraceX finds for you.

| Package | For |
| --- | --- |
| [`@tracexpro/browser`](packages/browser) | Browsers, React, Next.js (client) |
| [`@tracexpro/node`](packages/node) | Node.js 18+, Express, serverless |

```js
import * as TraceX from "@tracexpro/browser";

TraceX.init({ key: "txp_pub_…", release: "web@1.4.0" });
```

The key (`txp_pub_…`) comes from **Issues → Alerts and SDK** in TraceX. It can only send
errors, never read anything, so it's safe in frontend code. Events go to
`https://ingest.tracexpro.com/api/events`.

Docs: https://docs.tracexpro.com/errors/overview/

## Develop

```bash
npm install
npm test          # builds both packages, then runs the tests
npm run typecheck
```

`packages/core` is shared code bundled into each package (not published).

## Publish

```bash
npm run build
cd packages/browser && npm publish --access public
cd ../node && npm publish --access public
```

## License

MIT

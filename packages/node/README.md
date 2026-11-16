# @tracexpro/node

TraceX error tracking for Node.js 18+: uncaught exceptions, unhandled rejections and
Express request errors. No dependencies.

```bash
npm install @tracexpro/node
```

```js
const TraceX = require("@tracexpro/node");

TraceX.init({ key: "txp_pub_…", release: process.env.GIT_SHA });

app.use(TraceX.expressErrorHandler());   // after your routes
```

In serverless functions, `await TraceX.flush()` before returning.

Docs: https://docs.tracexpro.com/errors/node/

# @tracexpro/browser

TraceX error tracking for the browser: uncaught errors, unhandled promise rejections,
crashed React components and failed API calls, with the clicks, page changes and
requests before each one. About 4.5 KB gzipped, no dependencies.

```bash
npm install @tracexpro/browser
```

```js
import * as TraceX from "@tracexpro/browser";

TraceX.init({
  key: "txp_pub_…",          // TraceX → Issues → Alerts and SDK
  release: "web@1.4.0",
  environment: "production",
});

TraceX.setUser({ id: user.id });             // an id only; TraceX hashes it
TraceX.captureException(error, { tags: { step: "payment" } });
```

React error boundaries: `onError={TraceX.reactErrorHandler}`.

Docs: https://docs.tracexpro.com/errors/javascript/

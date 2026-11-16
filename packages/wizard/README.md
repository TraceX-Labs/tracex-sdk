# @tracexpro/wizard

Sets up TraceX error tracking in the app in the current folder:

```bash
npx @tracexpro/wizard
```

It detects your framework (Next.js, Vite + React, Vue, SvelteKit, Angular, React Router,
Express or Node), asks for the project's key (TraceX → Issues → Alerts and SDK), shows
every change and asks before making it, installs the SDK, writes the files and sends a
test event. It never overwrites a file: if one already exists, it shows what to add.

```bash
npx @tracexpro/wizard --key txp_pub_… --yes   # no questions (CI, scripts)
```

Docs: https://docs.tracexpro.com/errors/overview/

# MiniProgram Gate Templates

These templates show common `type: miniprogram` gate patterns. Copy the relevant
contract and runner into a mini-program project, then replace routes, selectors,
and expected text with project-specific values.

## Layout

```text
contracts/
  page-smoke.yaml
  tap-flow.yaml
  form-input.yaml
  navigation.yaml
  async-state.yaml
test/gates/
  miniprogram-template-helpers.js
  miniprogram-*.js
```

All contracts assume the compiled mini-program artifact lives at:

```text
dist/dev/mp-weixin
```

Adjust `projectPath` if your artifact path is different.

The templates assume an already-built mini-program artifact. In a Daytona-backed
Harness run, the Agent or project workflow should produce that artifact and
publish it through `candidateRoots`; the host-local mini-program gate then opens
the materialized artifact in WeChat DevTools.

Templates do not rebuild the project inside Gate by default. If you need
source reproducibility, add a separate `type: command` contract that installs
dependencies and runs the project-specific build, and treat failures from that
contract as rebuild failures rather than mini-program behavior failures.

## Run

Harness provides the `miniprogram-automator` dependency to trusted runners
through `NODE_PATH`; target projects do not need to install it only for gates.

Run managed mode through Harness:

Make sure `projectPath` exists before running the behavior gate. Harness does
not infer how to build the artifact from the framework.

```bash
harness check --dir contracts --json
```

Before starting a Daytona-backed Agent run, use preflight to verify that the
host can start or reach WeChat DevTools automation:

```bash
harness preflight gate --dir contracts --json
```

If preflight reports `hostLocal.<id>.devtools`, fix the local DevTools login,
security settings, trust prompt, or automation port before retrying the Agent.

Managed mode starts the local WeChat DevTools automation endpoint:

```yaml
devtools:
  mode: managed
  autoPort: 9420
  trustProject: true
```

For a manually started DevTools session, switch a contract to connect mode:

```yaml
devtools:
  mode: connect
  wsEndpoint: ws://127.0.0.1:9420
```

## Templates

| Contract | Runner | Purpose |
|---|---|---|
| `page-smoke.yaml` | `miniprogram-page-smoke.js` | Open a page and assert key text |
| `tap-flow.yaml` | `miniprogram-tap-flow.js` | Tap a button and wait for state text |
| `form-input.yaml` | `miniprogram-form-input.js` | Fill an input, submit, and assert result |
| `navigation.yaml` | `miniprogram-navigation.js` | Tap a link and assert the target route |
| `async-state.yaml` | `miniprogram-async-state.js` | Mock `wx.request` and wait for async UI state |

## Selector Contract

Prefer stable class selectors that are intentionally present for gate automation,
for example:

```xml
<view class="page-ready">
  <text class="page-title">首页</text>
  <button class="primary-action">继续</button>
</view>
```

Avoid selectors tied to visual-only layout, generated component internals, or
translated copy that changes frequently.

## Runner Guidance

Harness waits for the managed DevTools automation WebSocket to answer
`Tool.getInfo` with `SDKVersion` before starting the runner. The helper still
retries `automator.connect()` because connect-mode gates and some DevTools
versions can need a short post-start handshake.

Write runners as user-flow checks. Prefer visible routes, text, stable
automation classes, and list/card state. Avoid direct framework internals:

- Do not use `page.callMethod()` for uni-app, Vue, uView, or component methods.
  It calls native Page methods and often misses methods that the UI can invoke.
- Do not assert raw `page.data()` fields for uni-app/Vue3 output. Compiled Page
  data can be renamed or reshaped.
- Use `element.tap()` for native taps, `element.input(value)` for inputs, and
  `element.trigger("click")` only when a framework component's real public
  event is `click`.

Each runner closes the automator session in `finally` so repeated gate runs do not
leave stale sessions behind.

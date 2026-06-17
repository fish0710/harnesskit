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

## Run

Install the automator dependency in the target project:

```bash
npm install --save-dev miniprogram-automator
```

Run managed mode through Harness:

```bash
harness check --dir contracts --json
```

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

The helper retries `automator.connect()` because `cli auto` can return before the
WebSocket endpoint is fully ready. Keep that retry in project runners unless the
project has a stronger readiness signal.

Each runner closes the automator session in `finally` so repeated gate runs do not
leave stale sessions behind.

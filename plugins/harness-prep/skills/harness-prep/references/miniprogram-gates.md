# MiniProgram Gates

Use this reference when preparing WeChat mini-program contracts, runners, or
task-series gates.

## Execution Model

Mini-program gates are host-local gates. Harness may run the implementation
agent and normal command gates in Daytona, but WeChat DevTools runs on the
developer's macOS host. The miniprogram contract opens or connects to the local
DevTools automation WebSocket and then runs the trusted runner on the host.

Do not design a mini-program gate that requires WeChat DevTools inside the
Agent or Gate sandbox. The sandbox only needs to produce the compiled artifact;
the host gate consumes that artifact after Harness materializes the candidate
files.

## Contract Shape

Use `type: miniprogram` with a compiled artifact path and a trusted runner:

```yaml
id: mp.behavior
type: miniprogram
scenario: 小程序关键用户路径应保持可用
projectPath: dist/build/mp-weixin
runner: test/gates/mp-behavior-runner.js
devtools:
  mode: managed
  cliPath: /Applications/wechatwebdevtools.app/Contents/MacOS/cli
  autoPort: 9420
  trustProject: true
timeoutMs: 240000
expectExit: 0
ref: docs/specs/<date>-<slug>.md
```

For old/new dual gates, give each contract a different `autoPort`, for example
`9420` and `9421`. Keep `test/gates` protected because runners are judging
assets, not implementation code for the agent to rewrite during a Harness run.

Use `devtools.mode: connect` only when the user has already started DevTools
with automation enabled:

```yaml
devtools:
  mode: connect
  wsEndpoint: ws://127.0.0.1:9420
```

## Host Prerequisites

Before claiming a mini-program gate is ready, verify these host facts. Current
Harness Gate preflight also runs a host-local DevTools doctor for selected
mini-program contracts before creating an Agent sandbox:

- WeChat DevTools is installed at the configured `cliPath`.
- DevTools security settings allow automation and default trust for automation
  opened projects.
- The user is logged in when the flow or AppID requires it. Visitor mode can be
  acceptable for DOM-only smoke tests, but APIs such as account or security
  calls may emit DevTools runtime warnings.
- The compiled `projectPath` exists and contains `project.config.json`.
- The target project installs `miniprogram-automator`, commonly
  `miniprogram-automator@0.12.1`.

## Runner Rules

Write runners as black-box user-flow checks:

- Prefer visible routes, text, stable classes, test ids, and card/list state.
- Use `element.tap()` for real taps on native controls.
- Use `element.input(value)` for inputs.
- Use `element.trigger("click")` only when the real component contract emits a
  click event and tap does not exercise the framework wrapper.
- Always close the `miniProgram` session in `finally`.
- Add bounded waits or retries around asynchronous UI state.

Avoid these anti-patterns:

- Do not use `page.callMethod()` to call uni-app, Vue, uView, or component
  methods such as `handleAddOrder`. The method may not exist on the native
  Page object even though the UI can call it.
- Do not assert raw `page.data("orders")`, generated field names, or compiled
  Vue state. uni-app and Vue3 can compress or reshape Page data, so internal
  state is not a stable contract.
- Do not select generated internals such as `u-button`, `.u-btn`, or `data-v-*`
  unless the project has explicitly stabilized them for automation.
- Do not create one giant runner that attempts every possible operation. Use a
  small set of representative flows that cover the risky behavior.

## Runner Skeleton

```js
import automator from "miniprogram-automator";

const wsEndpoint = process.env.HARNESS_MINIPROGRAM_WS_ENDPOINT;
if (!wsEndpoint) throw new Error("HARNESS_MINIPROGRAM_WS_ENDPOINT is required");

const miniProgram = await automator.connect({ wsEndpoint });

try {
  const page = await miniProgram.reLaunch("/pages/index/index");
  await page.waitFor(".page-ready");

  const action = await page.$(".primary-action");
  if (!action) throw new Error("missing .primary-action");
  await action.tap();

  await page.waitFor(".status-done");
  const status = await page.$(".status-done");
  if (!status) throw new Error("missing .status-done");
  if ((await status.text()) !== "已完成") {
    throw new Error("unexpected status text");
  }
} finally {
  await miniProgram.close();
}
```

For framework components where tap does not hit the intended event, use an
explicit trigger after selecting a stable automation selector:

```js
const submit = await page.$(".submit-order");
if (!submit) throw new Error("missing .submit-order");
await submit.trigger("click");
```

## Validation Workflow

Run preflight before starting an Agent. For mini-program contracts, this checks
host DevTools automation readiness with a temporary doctor project. Readiness
means the automation WebSocket answers `Tool.getInfo` with `SDKVersion`, not
just that the TCP port is listening:

```bash
harness preflight gate --dir contracts --config harness.config.json --stage miniprogram-old --json
```

If this reports `hostLocal.<id>.devtools`, fix the host DevTools environment
first. Do not retry the implementation Agent; it cannot start macOS WeChat
DevTools from a Daytona sandbox.

Do not run preflight and the actual mini-program gate concurrently on the same
`autoPort`; WeChat DevTools exposes one automation project per port and the two
commands will race.

Build first when you want to run the actual host-local UI gate:

```bash
npm run build:mp-weixin
harness check --dir contracts --config harness.config.json --stage miniprogram-old --json
harness check --dir contracts --config harness.config.json --stage miniprogram-new --json
```

Classify common failures:

- `小程序项目目录不存在`: the build artifact was not generated or not included in
  the materialized candidate roots.
- `Failed connecting to ws://127.0.0.1:<port>`: DevTools automation is not
  available on that port, the wrong project window is open, or login/trust
  prerequisites are not met.
- `hostLocal.<id>.devtools`: host DevTools automation readiness failed during
  preflight. Inspect the included `islogin` and `auto` output before involving
  the Agent.
- `page.<method> not exists`, `Page data.orders must be an array`, or similar:
  the runner is coupled to framework internals instead of visible behavior.

When configuring a task series, make the build task produce the compiled
mini-program artifacts and include those artifact roots in `candidateRoots` if
later host-local mini-program gates must consume them.

# Mini-program Artifact-first Gate Design

## Problem

Mini-program Harness runs can fail for reasons that are not related to the
actual product behavior. A recent uni-app Vue2 counter run produced a valid
`dist/build/mp-weixin` artifact that passed the host-local mini-program click
gate, but the remote Gate failed during setup because it ran `npm ci`, triggered
`postinstall`, and the candidate upload did not include the referenced
`scripts/patch-uniapp.js` file.

That failure was useful for diagnosing packaging completeness, but it was not a
good answer to the product question: can WeChat DevTools open the built
mini-program and does a real button tap increment the visible counter?

## Goal

For ordinary mini-program implementation tasks, Harness should minimize failures
caused by npm, network access, Node versions, package lifecycle scripts, and
other environment differences. A failed run should usually mean that the Agent
did not produce the expected mini-program behavior or did not publish the
compiled artifact.

The default flow should be:

```text
task/spec
  -> Agent sandbox writes code, installs dependencies, and builds
  -> Agent publishes source plus dist/build/mp-weixin
  -> Gate performs lightweight artifact checks without npm install
  -> host-local mini-program gate opens dist/build/mp-weixin in WeChat DevTools
  -> trusted runner performs real user actions and asserts visible behavior
  -> passing candidate can be merged to the host
```

## Non-goals

- Do not make the Gate sandbox the default place to reinstall dependencies for
  mini-program behavior tasks.
- Do not make the Gate sandbox the default place to rebuild uni-app output.
- Do not require the target project to install `miniprogram-automator` only for
  trusted host-local runners.
- Do not hide packaging completeness problems. Surface them with focused checks
  instead of letting them appear as npm setup failures.

## Design

Mini-program tasks should use an artifact-first gate model. The Agent sandbox is
the construction site: it owns dependency installation, source edits, and the
mini-program build. The compiled `dist/build/mp-weixin` directory is the product
artifact. The Gate side should consume that artifact instead of recreating it.

The default selected gates for a mini-program behavior task should be:

1. A lightweight source or package structure check when useful.
2. A lightweight artifact check that validates `dist/build/mp-weixin` exists,
   contains `project.config.json`, and has the expected compiled page files.
3. A `type: miniprogram` host-local behavior gate that opens the compiled
   artifact in WeChat DevTools and performs real user actions such as `tap()`.

`gateSetup` should be empty by default for these tasks. Command contracts in the
default path should use only tools that exist in the Gate runtime snapshot and
should not fetch dependencies from the network. They should report missing or
malformed artifacts directly.

## Candidate Boundaries

`candidateRoots` must include the files that should merge to the host and the
compiled artifact the host-local mini-program gate needs. For a uni-app Vue2
demo, that commonly means:

- `src`
- `static`
- package manifests and build config when the task owns them
- any helper directories referenced by package lifecycle scripts, when such
  scripts are intentionally allowed
- `dist/build/mp-weixin`

For simple demo tasks, package lifecycle scripts such as `postinstall` and
`prepare` should be avoided unless explicitly required. If they are present,
their referenced files must be part of the candidate or the task should fail a
focused packaging check.

## Build Reproducibility Gate

A Gate-side `npm ci` plus `npm run build:mp-weixin` contract is still valuable,
but it should be an opt-in stricter gate named and documented as source
reproducibility. It answers a different question: can a fresh remote environment
rebuild this mini-program from the candidate source?

That gate should not be part of the default product behavior path because it
adds failure modes from dependency installation, registry access, Node versions,
and package lifecycle scripts before the user-visible mini-program behavior is
tested.

## Error Classification

The artifact-first model keeps failure feedback closer to the user's intent:

- Missing `dist/build/mp-weixin`: the Agent did not publish the build output.
- Missing `project.config.json`: the published artifact is not a valid WeChat
  mini-program project.
- Missing compiled page files: the build output is incomplete.
- WeChat DevTools runner failure: the built mini-program behavior is wrong or
  the host DevTools prerequisite is not ready.
- Opt-in reproducibility gate failure: the source cannot be rebuilt in a fresh
  remote environment.

## Acceptance

The model is correct when a mini-program counter task can pass or fail primarily
on these questions:

- Did the Agent publish `dist/build/mp-weixin`?
- Can WeChat DevTools open that artifact?
- Does a real tap on the button increment the visible counter by one?

It should not normally fail because Gate reinstalled dependencies, ran
`postinstall`, reached the npm registry, or used a different build environment.

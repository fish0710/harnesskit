import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { loadContracts } from "../src/contracts.js";

const exampleRoot = join(process.cwd(), "examples/miniprogram");
const harnessPrepRoot = join(process.cwd(), "plugins/harness-prep/skills/harness-prep");

test("miniprogram examples provide representative runner templates", () => {
  const contractsDir = join(exampleRoot, "contracts");
  const { contracts, issues } = loadContracts(contractsDir);

  assert.deepEqual(issues, []);
  assert.deepEqual(
    contracts.map((contract) => contract.id).sort(),
    [
      "mp.template.async-state",
      "mp.template.form-input",
      "mp.template.navigation",
      "mp.template.page-smoke",
      "mp.template.tap-flow",
    ],
  );

  for (const contract of contracts) {
    assert.equal(contract.type, "miniprogram");
    assert.equal(contract.projectPath, "dist/dev/mp-weixin");
    assert.match(String(contract.runner), /^test\/gates\/miniprogram-/);
    const runnerPath = join(exampleRoot, String(contract.runner));
    assert.equal(existsSync(runnerPath), true, `${contract.id} runner is missing`);

  }

  for (const file of readdirSync(join(exampleRoot, "test/gates"))) {
    if (!file.endsWith(".js")) continue;
    const syntax = spawnSync(process.execPath, ["--check", join(exampleRoot, "test/gates", file)], {
      cwd: exampleRoot,
      encoding: "utf8",
    });
    assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout);
  }

  assert.equal(existsSync(join(exampleRoot, "README.md")), true);
});

test("miniprogram prep skill documents host-local runner rules", () => {
  const skill = readFileSync(join(harnessPrepRoot, "SKILL.md"), "utf8");
  const referencePath = join(harnessPrepRoot, "references/miniprogram-gates.md");
  const reference = readFileSync(referencePath, "utf8");
  const readme = readFileSync(join(exampleRoot, "README.md"), "utf8");
  const helpers = readFileSync(join(exampleRoot, "test/gates/miniprogram-template-helpers.js"), "utf8");

  assert.match(skill, /references\/miniprogram-gates\.md/);
  assert.match(reference, /host-local/);
  assert.match(reference, /harness preflight gate/);
  assert.match(reference, /hostLocal\.<id>\.devtools/);
  assert.match(reference, /NODE_PATH/);
  assert.match(reference, /miniprogram-automator@0\.12\.1/);
  assert.match(reference, /createRequire/);
  assert.match(reference, /Artifact-first Default/);
  assert.match(reference, /Agent sandbox owns dependency installation and framework-specific builds/);
  assert.match(reference, /Gate-side rebuilds are opt-in source reproducibility checks/);
  assert.match(reference, /Clean Build Final Task/);
  assert.match(reference, /final series task/);
  assert.match(reference, /Do not mix this with the behavior parity task/);
  assert.match(reference, /source-reproducibility failure/);
  assert.match(reference, /Do not make npm ci or npm run build the default Gate path/);
  assert.match(reference, /not a uni-app, Taro, or native mini-program build plugin/);
  assert.match(reference, /page\.callMethod\(\)/);
  assert.match(reference, /page\.data/);
  assert.match(reference, /uni-app/);
  assert.match(reference, /trigger\("click"\)/);
  assert.match(readme, /page\.callMethod\(\)/);
  assert.match(readme, /page\.data/);
  assert.match(readme, /uni-app\/Vue3/);
  assert.match(readme, /NODE_PATH/);
  assert.match(readme, /already-built mini-program artifact/);
  assert.match(readme, /Templates do not rebuild the project inside Gate by default/);
  assert.match(readme, /source reproducibility/);
  assert.match(helpers, /createRequire\(import\.meta\.url\)\("miniprogram-automator"\)/);
  assert.match(helpers, /export async function inputText/);
  assert.match(helpers, /export async function tapElement/);
  assert.match(helpers, /export async function triggerElement/);
});

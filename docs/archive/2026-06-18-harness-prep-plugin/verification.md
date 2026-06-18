# Verification

## Plugin Validation

命令：

```bash
PYTHONPATH=/private/tmp/harness-plugin-pydeps \
  python3 /Users/zhongyy40/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py \
  plugins/harness-prep
```

结果：

```text
Plugin validation passed: .../plugins/harness-prep
```

## Skill Validation

命令：

```bash
PYTHONPATH=/private/tmp/harness-plugin-pydeps \
  python3 /Users/zhongyy40/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  plugins/harness-prep/skills/harness-prep
```

结果：

```text
Skill is valid!
```

## Reference And Markdown Checks

命令：

```bash
node -e 'const fs=require("fs"); const path=require("path"); const root="plugins/harness-prep/skills/harness-prep"; const skill=fs.readFileSync(path.join(root,"SKILL.md"),"utf8"); const refs=[...skill.matchAll(/`(references\/[^`]+)`/g)].map(m=>m[1]); const missing=refs.filter(r=>!fs.existsSync(path.join(root,r))); if(missing.length){console.error("missing",missing); process.exit(1)} console.log(`references ok ${refs.length}`);'

node -e 'let ok=true; for (const f of process.argv.slice(1)) { const text=require("fs").readFileSync(f,"utf8"); const count=(text.match(/^```/gm)||[]).length; if(count%2){console.error(`unbalanced fences ${f}: ${count}`); ok=false;} } if(!ok) process.exit(1); console.log(`fences ok ${process.argv.length-1}`);' $(find plugins/harness-prep/skills/harness-prep -name '*.md' -print)
```

结果：

```text
references ok 10
fences ok 11
```

## Full Harness Test Suite

命令：

```bash
npm run check
```

结果：

```text
tests 435
pass 435
fail 0
```

## Diff Whitespace Check

命令：

```bash
git diff --check
```

结果：

```text
exit 0
```

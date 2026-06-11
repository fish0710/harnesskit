import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

function slug(task: string): string {
  return task.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task";
}

/**
 * 生成执行计划 Plan.md(模板)。真实版可由 driver/AI 起草,但定稿与验收契约由人/评估器侧负责。
 * 返回写入路径。
 */
export function writePlan(cwd: string, task: string): string {
  const dir = join(cwd, "docs", "plans");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${slug(task)}.md`);
  const content = `# 执行计划:${task}

> 由 \`harness plan\` 生成的模板。意图层产物——AI 可协助起草,验收契约由评估器侧独立定稿并冻结。

## 目标
${task}

## 约束 / 不可违反
- 满足相关契约才算完成(\`harness check\` 全绿)
- 遵守分层与原则(见 docs/decisions、docs/reference/principles.md)
- 不改冻结契约(改契约=改规则,走人审)

## 分步计划(sprint)
- [ ] 步骤 1:……(产出物 / 验收信号)
- [ ] 步骤 2:……
- [ ] 步骤 3:……

## 验收契约(由评估器侧独立编写、动工前冻结;查行为不查工件)
- [ ] 行为 1:给定 ……,应 ……  → 在 contracts/ 写一条 http/ui/invariant 契约并 \`harness contract freeze\`
- [ ] 行为 2:……

## 移交笔记(context reset / 换实例时填写)
<已完成什么、当前状态、下一步从哪继续>
`;
  writeFileSync(path, content, "utf8");
  return path;
}

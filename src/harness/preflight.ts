import type { GateReport, Contract } from "../types.js";
import type { SandboxPolicy } from "./sandbox/types.js";

export type PreflightSeverity = "warning" | "error";

export interface PreflightFinding {
  id: string;
  severity: PreflightSeverity;
  message: string;
  source: "static" | "setup" | "contract" | "sandbox";
  contractId?: string;
}

export interface PreflightStep {
  label: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GatePreflightReport {
  outcome: "ready" | "not_ready" | "blocked";
  staticFindings: PreflightFinding[];
  setup: PreflightStep[];
  selectedContracts: string[];
  remoteContracts: string[];
  hostLocalContracts: string[];
  gateReport?: GateReport;
  readinessErrors: PreflightFinding[];
  productFailures: string[];
  sandbox?: { id: string; snapshot: string; retained: boolean };
}

export interface GateReadinessLintInput {
  contracts: Contract[];
  policy: SandboxPolicy;
}

export interface GateReadinessClassification {
  readinessErrors: PreflightFinding[];
  productFailures: string[];
}

const MISSING_DEFAULT_TOOLS = new Set(["git", "pnpm", "yarn", "bun"]);

type ShellOperator = "start" | "&&" | "||" | ";";

interface ShellSegment {
  operator: ShellOperator;
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function mentionsExecutableName(command: string, name: string): boolean {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    "(?:^|[\\s\"'`;&|()])(?:[A-Za-z0-9_./~-]+\\/)?" +
      escapedName +
      "(?:$|[\\s\"'`;&|()<>])",
  ).test(command);
}

function mentionsExecutableNameOutsideQuotes(command: string, name: string): boolean {
  return mentionsExecutableName(maskQuotedText(command), name);
}

function maskQuotedText(command: string): string {
  let masked = "";
  let quote: "'" | "\"" | "`" | undefined;
  let escaped = false;
  for (const char of command) {
    if (escaped) {
      masked += quote ? " " : char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      masked += quote ? " " : char;
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      masked += " ";
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      masked += " ";
      continue;
    }
    masked += char;
  }
  return masked;
}

function wholeShellScript(command: string): string | undefined {
  const match = /^\s*(?:bash|sh|zsh)\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(command);
  return match?.[2];
}

function currentShellNvmUsesAreSourced(command: string): boolean {
  let sourced = false;
  const unquoted = maskQuotedText(command);
  if (/[;]/.test(unquoted) || /\|\|/.test(unquoted)) return false;
  const segments = unquoted
    .split(/&&/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  for (const segment of segments) {
    if (
      /^(?:source|\.)\s+\/usr\/local\/nvm\/nvm\.sh(?:\s|$)/.test(segment) &&
      !/[|<>]/.test(segment)
    ) {
      sourced = true;
    }
    if (/\bnvm\s+use\b/.test(segment) && !/^nvm\s+use\b/.test(segment)) {
      return false;
    }
    if (/\bnvm\s+use\b/.test(segment) && /[|<>]/.test(segment)) return false;
    if (/\bnvm\s+use\b/.test(segment) && !sourced) return false;
  }
  return true;
}

function hasBareNvmUse(command: string): boolean {
  if (!/\bnvm\s+use\b/.test(command)) return false;
  for (const segment of shellSegments(command)) {
    const script = wholeShellScript(segment.text);
    if (script !== undefined && hasBareNvmUse(script)) return true;
  }
  const unquoted = maskQuotedText(command);
  return /\bnvm\s+use\b/.test(unquoted) && !currentShellNvmUsesAreSourced(command);
}

function usesNvmInstall(command: string): boolean {
  if (!/\bnvm\s+install\b/.test(command)) return false;
  return shellSegments(command).some((segment) => {
    const script = wholeShellScript(segment.text);
    if (script !== undefined) return usesNvmInstall(script);
    return /^(?:[A-Za-z0-9_./~-]+\/)?nvm\s+install(?:\s|$)/.test(
      maskQuotedText(segment.text).trim(),
    );
  });
}

function commandMentionsMissingTool(command: string): string | undefined {
  for (const segment of shellSegments(command)) {
    const script = wholeShellScript(segment.text);
    if (script !== undefined) {
      const tool = commandMentionsMissingTool(script);
      if (tool) return tool;
      continue;
    }
    for (const tool of MISSING_DEFAULT_TOOLS) {
      if (mentionsExecutableNameOutsideQuotes(segment.text, tool)) return tool;
    }
  }
  return undefined;
}

function commandMentionsClaude(command: string): boolean {
  return shellSegments(command).some((segment) => {
    const script = wholeShellScript(segment.text);
    return script !== undefined
      ? commandMentionsClaude(script)
      : mentionsExecutableNameOutsideQuotes(segment.text, "claude");
  });
}

function shellSegments(command: string): ShellSegment[] {
  const segments: ShellSegment[] = [];
  let quote: "'" | "\"" | "`" | undefined;
  let escaped = false;
  let current = "";
  let operator: ShellOperator = "start";
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      current += char;
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    const pair = command.slice(index, index + 2);
    if (pair === "&&" || pair === "||") {
      if (current.trim()) segments.push({ operator, text: current.trim() });
      current = "";
      operator = pair;
      index++;
      continue;
    }
    if (char === ";") {
      if (current.trim()) segments.push({ operator, text: current.trim() });
      current = "";
      operator = ";";
      continue;
    }
    current += char;
  }
  if (current.trim()) segments.push({ operator, text: current.trim() });
  return segments;
}

function bootstrapMentionsTool(command: string, tool: string): boolean {
  const bootstrapped = new Set<string>();
  gateSetupMissingTool(command, bootstrapped);
  return bootstrapped.has(tool);
}

function segmentBootstrapsTool(segment: string, tool: string): boolean {
  const script = wholeShellScript(segment);
  if (script !== undefined) return bootstrapMentionsTool(script, tool);
  if (tool === "pnpm") {
    return /^corepack\s+enable\s+["']?pnpm(?:@[^"'\s]+)?["']?(?:\s|$)/.test(segment) ||
      /^npm\s+(?:install|i)\s+-g\s+["']?pnpm(?:@[^"'\s]+)?["']?(?:\s|$)/.test(segment);
  }
  if (tool === "yarn") {
    return /^corepack\s+enable\s+["']?yarn(?:@[^"'\s]+)?["']?(?:\s|$)/.test(segment) ||
      /^npm\s+(?:install|i)\s+-g\s+["']?yarn(?:@[^"'\s]+)?["']?(?:\s|$)/.test(segment);
  }
  if (tool === "bun") {
    return /^npm\s+(?:install|i)\s+-g\s+["']?bun(?:@[^"'\s]+)?["']?(?:\s|$)/.test(segment) ||
      /^curl\b[\s\S]*\bbun\.sh\/install["']?\b[\s\S]*\|\s*bash\b/.test(segment);
  }
  if (tool === "git") {
    return /^apt(?:-get)?\s+install\b[\s\S]*\bgit\b/.test(segment);
  }
  return false;
}

function gateSetupMissingTool(
  command: string,
  bootstrapped: Set<string>,
): string | undefined {
  const initialBootstrapped = new Set(bootstrapped);
  const commandReliableBootstraps = new Set<string>();
  let branchBootstrapped = new Set(bootstrapped);
  let canPersistBootstraps = true;

  for (const segment of shellSegments(command)) {
    if (segment.operator === ";" || segment.operator === "||") {
      branchBootstrapped = new Set(initialBootstrapped);
      canPersistBootstraps = false;
    }
    const script = wholeShellScript(segment.text);
    if (script !== undefined) {
      const nestedBootstrapped = new Set(branchBootstrapped);
      const tool = gateSetupMissingTool(script, nestedBootstrapped);
      if (tool) return tool;
      for (const bootstrappedTool of nestedBootstrapped) {
        if (!branchBootstrapped.has(bootstrappedTool)) {
          branchBootstrapped.add(bootstrappedTool);
          commandReliableBootstraps.add(bootstrappedTool);
        }
      }
      continue;
    }
    for (const tool of MISSING_DEFAULT_TOOLS) {
      if (segmentBootstrapsTool(segment.text, tool)) {
        branchBootstrapped.add(tool);
        commandReliableBootstraps.add(tool);
      }
    }
    for (const tool of MISSING_DEFAULT_TOOLS) {
      if (
        !branchBootstrapped.has(tool) &&
        mentionsExecutableNameOutsideQuotes(segment.text, tool)
      ) {
        return tool;
      }
    }
  }
  if (canPersistBootstraps) {
    for (const tool of commandReliableBootstraps) bootstrapped.add(tool);
  }
  return undefined;
}

function setupBootstrapsTool(policy: SandboxPolicy, tool: string): boolean {
  return policy.gateSetup.some((command) => bootstrapMentionsTool(command, tool));
}

function contractCommandText(contract: Contract): string | undefined {
  if (contract.type === "command" || contract.type === "boot") {
    const cmd = typeof contract.cmd === "string" ? contract.cmd : undefined;
    const args = Array.isArray(contract.args)
      ? contract.args.map(String).join(" ")
      : "";
    return cmd ? `${cmd} ${args}`.trim() : undefined;
  }
  if (contract.type === "structure") {
    const tool = typeof contract.tool === "string" ? contract.tool : undefined;
    const args = Array.isArray(contract.args)
      ? contract.args.map(String).join(" ")
      : "";
    return tool ? `${tool} ${args}`.trim() : undefined;
  }
  return undefined;
}

function httpContractUsesLoopback(contract: Contract): boolean {
  if (contract.type !== "http" || !isRecord(contract.trigger)) return false;
  const trigger = contract.trigger;
  const values = [trigger.url, trigger.baseUrl].filter(
    (value): value is string => typeof value === "string",
  );
  return values.some((value) => {
    try {
      const host = new URL(value).hostname;
      return host === "localhost" ||
        host === "127.0.0.1" ||
        host === "::1" ||
        host.endsWith(".localhost");
    } catch {
      return false;
    }
  });
}

function runtimeFailureText(value: string): boolean {
  return value
    .toLowerCase()
    .split(/\r?\n/)
    .some(runtimeFailureLine);
}

function runtimeFailureLine(line: string): boolean {
  if (productAssertionText(line)) {
    const actual = /\b(?:but\s+(?:got|received|actual)|received|actual)\b(?<actual>.*)$/.exec(line)
      ?.groups?.actual;
    return actual ? rawRuntimeFailureText(actual) : false;
  }
  return rawRuntimeFailureText(line);
}

function rawRuntimeFailureText(text: string): boolean {
  return text.includes("command not found") ||
    text.includes("exit code 127") ||
    text.includes("退出码 127") ||
    text.includes(": not found") ||
    text.includes("nvm: not found") ||
    text.includes("nvm.sh") ||
    (text.includes("n/a: version") && text.includes("not yet installed")) ||
    text.includes("cannot find module") ||
    text.includes("err_module_not_found") ||
    text.includes("cannot find package") ||
    text.includes("module not found") ||
    text.includes("missing script") ||
    text.includes("enoent") ||
    text.includes("network is unreachable") ||
    text.includes("could not resolve host") ||
    text.includes("temporary failure in name resolution") ||
    text.includes("name or service not known") ||
    text.includes("enotfound") ||
    text.includes("econnrefused") ||
    text.includes("connection refused") ||
    text.includes("failed to connect") ||
    text.includes("connection timed out") ||
    text.includes("request timeout after") ||
    text.includes("timed out while") ||
    text.includes("etimedout") ||
    text.includes("und_err_connect_timeout") ||
    text.includes("connect timeout") ||
    text.includes("process timed out") ||
    text.includes("command timed out");
}

function productAssertionText(text: string): boolean {
  return /(?:^|[:\]])\s*expected\b/.test(text) ||
    /\bassertionerror(?:\s+\[[^\]]+\])?:\s*expected\b/.test(text);
}

function resultText(result: GateReport["results"][number]): string {
  return [
    result.errorReason ?? "",
    ...result.violations.flatMap((violation) => [
      violation.what,
      violation.why,
      violation.how,
      violation.file ?? "",
    ]),
  ].filter(Boolean).join("\n");
}

function finding(
  id: string,
  severity: PreflightSeverity,
  message: string,
  source: PreflightFinding["source"],
  contractId?: string,
): PreflightFinding {
  return {
    id,
    severity,
    message,
    source,
    ...(contractId ? { contractId } : {}),
  };
}

export function lintGateReadiness(input: GateReadinessLintInput): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  const gateSetupBootstrappedTools = new Set<string>();

  input.policy.gateSetup.forEach((command, index) => {
    const label = `gateSetup.${index + 1}`;
    if (hasBareNvmUse(command)) {
      findings.push(finding(
        `${label}.nvm`,
        "error",
        "Gate setup uses bare nvm. Use bash -lc 'source /usr/local/nvm/nvm.sh && nvm use <version> && ...'.",
        "static",
      ));
    }
    if (usesNvmInstall(command)) {
      findings.push(finding(
        `${label}.nvm-install`,
        "error",
        "Gate setup uses nvm install. Gate /usr/local/nvm is not writable; use a snapshot with the Node version preinstalled.",
        "static",
      ));
    }
    if (commandMentionsClaude(command)) {
      findings.push(finding(
        `${label}.claude`,
        "error",
        "Gate setup must not run claude; Gate snapshots are intentionally agent-free.",
        "static",
      ));
    }
    const tool = gateSetupMissingTool(command, gateSetupBootstrappedTools);
    if (tool) {
      findings.push(finding(
        `${label}.tool`,
        "error",
        `Gate setup uses ${tool}, which is not in the default Gate snapshot. Install or enable it before invoking it.`,
        "static",
      ));
    }
  });

  for (const contract of input.contracts) {
    const command = contractCommandText(contract);
    if (command) {
      if (hasBareNvmUse(command)) {
        findings.push(finding(
          `contract.${contract.id}.nvm`,
          "error",
          "Contract command uses bare nvm. Source /usr/local/nvm/nvm.sh in gateSetup or in an explicit bash wrapper.",
          "static",
          contract.id,
        ));
      }
      if (usesNvmInstall(command)) {
        findings.push(finding(
          `contract.${contract.id}.nvm-install`,
          "error",
          "Contract command uses nvm install. Install Node versions in the Gate snapshot or gateSetup, not during contract execution.",
          "static",
          contract.id,
        ));
      }
      if (commandMentionsClaude(command)) {
        findings.push(finding(
          `contract.${contract.id}.claude`,
          "error",
          "Gate contracts must not run claude; Gate snapshots do not include model tooling.",
          "static",
          contract.id,
        ));
      }
      const tool = commandMentionsMissingTool(command);
      if (tool && !setupBootstrapsTool(input.policy, tool)) {
        findings.push(finding(
          `contract.${contract.id}.tool`,
          "error",
          `Contract uses ${tool}, which is not in the default Gate snapshot and is not bootstrapped by gateSetup.`,
          "static",
          contract.id,
        ));
      }
      if (
        /\b(?:npm|pnpm|yarn|bun|pip3?)\s+(?:install|ci)\b/.test(command) ||
        /\b(?:curl|wget)\b/.test(command)
      ) {
        findings.push(finding(
          `contract.${contract.id}.network`,
          "warning",
          "Contract command appears to fetch dependencies or network resources. Move dependency installation to gateSetup before Gate network policy is applied.",
          "static",
          contract.id,
        ));
      }
    }
    if (httpContractUsesLoopback(contract) && input.policy.gateSetup.length === 0) {
      findings.push(finding(
        `contract.${contract.id}.loopback`,
        "warning",
        "Loopback HTTP contract targets the Gate sandbox. Add gateSetup that starts and waits for the service.",
        "static",
        contract.id,
      ));
    }
  }

  return findings;
}

export function classifyGateReportReadiness(
  report: GateReport,
): GateReadinessClassification {
  const readinessErrors: PreflightFinding[] = [];
  const productFailures: string[] = [];

  for (const result of report.results) {
    const text = resultText(result);
    if (result.status === "error") {
      readinessErrors.push(finding(
        `contract.${result.id}.error`,
        "error",
        text || "Gate contract returned error",
        "contract",
        result.id,
      ));
      continue;
    }
    if (result.status === "fail" && runtimeFailureText(text)) {
      readinessErrors.push(finding(
        `contract.${result.id}.runtime`,
        "error",
        text,
        "contract",
        result.id,
      ));
      continue;
    }
    if (result.status === "fail") {
      productFailures.push(result.id);
    }
  }

  return { readinessErrors, productFailures };
}

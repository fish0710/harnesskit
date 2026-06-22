import type { GateCore } from "../gate.js";
import type { GateReport, Contract, RunContext } from "../types.js";
import { isHostLocalContract } from "./host-gate.js";
import { createDaytonaExecutionTarget } from "./sandbox/daytona.js";
import { getGateSnapshot } from "./sandbox/toolchain.js";
import type {
  SandboxCommandResult,
  SandboxHandle,
  SandboxPolicy,
  SandboxProvider,
} from "./sandbox/types.js";
import { agentVisibleFiles, captureWorkspace } from "./sandbox/workspace.js";

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
  baseUrl?: string;
}

export interface GateReadinessClassification {
  readinessErrors: PreflightFinding[];
  productFailures: string[];
}

export interface GatePreflightOptions {
  provider: SandboxProvider;
  root: string;
  policy: SandboxPolicy;
  contracts: Contract[];
  gate: GateCore;
  ctx: RunContext;
  environment?: Record<string, string | undefined>;
  retainOnFailure?: boolean;
}

const MISSING_DEFAULT_TOOLS = new Set(["git", "pnpm", "yarn", "bun"]);
const REMOTE_ROOT = "/workspace/candidate";
const SETUP_TIMEOUT_MS = 10 * 60 * 1000;

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

function shellWords(command: string): string[] | undefined {
  const words: string[] = [];
  let current = "";
  let quote: "'" | "\"" | "`" | undefined;
  let escaped = false;
  for (const char of command.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (quote || escaped) return undefined;
  if (current) words.push(current);
  return words;
}

function executableName(command: string): string {
  let value = command.trim();
  while (value.startsWith("(")) value = value.slice(1);
  while (value.endsWith(")")) value = value.slice(0, -1);
  return value.split(/[\\/]/).at(-1) ?? value;
}

function executableIs(command: string, name: string): boolean {
  return executableName(command) === name;
}

function isEnvAssignment(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

function wholeShellScript(command: string): string | undefined {
  const words = shellWords(command);
  if (!words || words.length < 3) return undefined;
  const commandIndex = words.findIndex((word) => !isEnvAssignment(word));
  if (commandIndex < 0 || words.length - commandIndex < 3) return undefined;
  if (!["bash", "sh", "zsh"].includes(executableName(words[commandIndex]!))) {
    return undefined;
  }
  for (let index = commandIndex + 1; index < words.length - 1; index++) {
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(words[index]!)) {
      return words[index + 1];
    }
  }
  return undefined;
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
    return /(?:^|[\s;&|()])(?:[A-Za-z0-9_./~-]+\/)?nvm\s+install(?:[\s)&;|]|$)/.test(
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

function shellSegmentAlwaysFails(segment: string): boolean {
  const words = shellWords(segment);
  return words?.[0] === "false";
}

function gateSetupMissingTool(
  command: string,
  bootstrapped: Set<string>,
): string | undefined {
  const initialBootstrapped = new Set(bootstrapped);
  const commandReliableBootstraps = new Set<string>();
  let branchBootstrapped = new Set(bootstrapped);
  let canPersistBootstraps = true;
  let previousAlwaysFails = false;

  for (const segment of shellSegments(command)) {
    if (segment.operator === ";" || segment.operator === "||") {
      branchBootstrapped = new Set(initialBootstrapped);
      canPersistBootstraps = false;
      previousAlwaysFails = false;
    }
    const segmentRuns = !(segment.operator === "&&" && previousAlwaysFails);
    if (!segmentRuns) {
      previousAlwaysFails = false;
      continue;
    }
    const script = wholeShellScript(segment.text);
    if (script !== undefined) {
      const nestedBootstrapped = new Set(branchBootstrapped);
      const tool = gateSetupMissingTool(script, nestedBootstrapped);
      if (tool) return tool;
      for (const bootstrappedTool of nestedBootstrapped) {
        if (!branchBootstrapped.has(bootstrappedTool)) {
          branchBootstrapped.add(bootstrappedTool);
          if (canPersistBootstraps) commandReliableBootstraps.add(bootstrappedTool);
        }
      }
      previousAlwaysFails = shellSegmentAlwaysFails(segment.text);
      continue;
    }
    for (const tool of MISSING_DEFAULT_TOOLS) {
      if (segmentBootstrapsTool(segment.text, tool)) {
        branchBootstrapped.add(tool);
        if (canPersistBootstraps) commandReliableBootstraps.add(tool);
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
    previousAlwaysFails = shellSegmentAlwaysFails(segment.text);
  }
  if (canPersistBootstraps) {
    for (const tool of commandReliableBootstraps) bootstrapped.add(tool);
  }
  return undefined;
}

function setupBootstrapsTool(policy: SandboxPolicy, tool: string): boolean {
  return policy.gateSetup.some((command) => bootstrapMentionsTool(command, tool));
}

interface ContractCommand {
  cmd: string;
  args: string[];
}

function contractCommand(contract: Contract): ContractCommand | undefined {
  if (contract.type === "command" || contract.type === "boot") {
    const cmd = typeof contract.cmd === "string" ? contract.cmd : undefined;
    const args = Array.isArray(contract.args)
      ? contract.args.map(String)
      : [];
    return cmd ? { cmd, args } : undefined;
  }
  if (contract.type === "structure") {
    const tool = typeof contract.tool === "string" ? contract.tool : undefined;
    const args = Array.isArray(contract.args)
      ? contract.args.map(String)
      : [];
    return tool ? { cmd: tool, args } : undefined;
  }
  return undefined;
}

function structuredShellScript(command: ContractCommand): string | undefined {
  if (!["bash", "sh", "zsh"].includes(executableName(command.cmd))) return undefined;
  for (let index = 0; index < command.args.length - 1; index++) {
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(command.args[index]!)) {
      return command.args[index + 1];
    }
  }
  return undefined;
}

function envChildCommand(command: ContractCommand): ContractCommand | undefined {
  if (!executableIs(command.cmd, "env")) return undefined;
  let index = 0;
  while (index < command.args.length) {
    const arg = command.args[index]!;
    if (arg === "--") {
      index++;
      break;
    }
    if (isEnvAssignment(arg)) {
      index++;
      continue;
    }
    if (arg === "-u" || arg === "--unset" || arg === "-C" || arg === "--chdir") {
      index += 2;
      continue;
    }
    if (
      arg.startsWith("-u") ||
      arg.startsWith("--unset=") ||
      arg.startsWith("-C") ||
      arg.startsWith("--chdir=")
    ) {
      index++;
      continue;
    }
    if (arg.startsWith("-")) {
      index++;
      continue;
    }
    break;
  }
  if (index >= command.args.length) return undefined;
  return {
    cmd: command.args[index]!,
    args: command.args.slice(index + 1),
  };
}

function contractHasBareNvmUse(command: ContractCommand): boolean {
  const script = structuredShellScript(command);
  if (script !== undefined) return hasBareNvmUse(script);
  const child = envChildCommand(command);
  if (child) return contractHasBareNvmUse(child);
  return executableIs(command.cmd, "nvm") && command.args[0] === "use";
}

function contractUsesNvmInstall(command: ContractCommand): boolean {
  const script = structuredShellScript(command);
  if (script !== undefined) return usesNvmInstall(script);
  const child = envChildCommand(command);
  if (child) return contractUsesNvmInstall(child);
  return executableIs(command.cmd, "nvm") && command.args[0] === "install";
}

function contractMentionsClaude(command: ContractCommand): boolean {
  const script = structuredShellScript(command);
  if (script !== undefined) return commandMentionsClaude(script);
  const child = envChildCommand(command);
  if (child) return contractMentionsClaude(child);
  return executableIs(command.cmd, "claude");
}

function contractMentionsMissingTool(command: ContractCommand): string | undefined {
  const script = structuredShellScript(command);
  if (script !== undefined) return commandMentionsMissingTool(script);
  const child = envChildCommand(command);
  if (child) return contractMentionsMissingTool(child);
  for (const tool of MISSING_DEFAULT_TOOLS) {
    if (executableIs(command.cmd, tool)) return tool;
  }
  return undefined;
}

function shellCommandUsesNetwork(command: string): boolean {
  const unquoted = maskQuotedText(command);
  return /\b(?:npm|pnpm|yarn|bun|pip3?)\s+(?:install|ci)\b/.test(unquoted) ||
    /\b(?:curl|wget)\b/.test(unquoted);
}

function contractUsesNetwork(command: ContractCommand): boolean {
  const script = structuredShellScript(command);
  if (script !== undefined) return shellCommandUsesNetwork(script);
  const child = envChildCommand(command);
  if (child) return contractUsesNetwork(child);
  const installer = ["npm", "pnpm", "yarn", "bun", "pip", "pip3"].some((tool) =>
    executableIs(command.cmd, tool)
  );
  return (installer && /^(?:install|ci)$/.test(command.args[0] ?? "")) ||
    executableIs(command.cmd, "curl") ||
    executableIs(command.cmd, "wget");
}

function httpContractUsesLoopback(
  contract: Contract,
  fallbackBaseUrl?: string,
): boolean {
  if (contract.type !== "http" || !isRecord(contract.trigger)) return false;
  const trigger = contract.trigger;
  const values = [
    trigger.url,
    trigger.baseUrl,
    typeof trigger.path === "string" ? fallbackBaseUrl : undefined,
  ].filter(
    (value): value is string => typeof value === "string",
  );
  return values.some((value) => {
    try {
      const host = new URL(value).hostname.replace(/^\[(.*)\]$/, "$1");
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
    const actual = /\b(?:but\s+(?:got|received|actual)|got|received|actual)\b(?<actual>.*)$/.exec(line)
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
  return /(?:^|[:\]\-])\s*expected\b/.test(text) ||
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
    const command = contractCommand(contract);
    if (command) {
      if (contractHasBareNvmUse(command)) {
        findings.push(finding(
          `contract.${contract.id}.nvm`,
          "error",
          "Contract command uses bare nvm. Source /usr/local/nvm/nvm.sh in gateSetup or in an explicit bash wrapper.",
          "static",
          contract.id,
        ));
      }
      if (contractUsesNvmInstall(command)) {
        findings.push(finding(
          `contract.${contract.id}.nvm-install`,
          "error",
          "Contract command uses nvm install. Install Node versions in the Gate snapshot or gateSetup, not during contract execution.",
          "static",
          contract.id,
        ));
      }
      if (contractMentionsClaude(command)) {
        findings.push(finding(
          `contract.${contract.id}.claude`,
          "error",
          "Gate contracts must not run claude; Gate snapshots do not include model tooling.",
          "static",
          contract.id,
        ));
      }
      const tool = contractMentionsMissingTool(command);
      if (tool && !setupBootstrapsTool(input.policy, tool)) {
        findings.push(finding(
          `contract.${contract.id}.tool`,
          "error",
          `Contract uses ${tool}, which is not in the default Gate snapshot and is not bootstrapped by gateSetup.`,
          "static",
          contract.id,
        ));
      }
      if (contractUsesNetwork(command)) {
        findings.push(finding(
          `contract.${contract.id}.network`,
          "warning",
          "Contract command appears to fetch dependencies or network resources. Move dependency installation to gateSetup before Gate network policy is applied.",
          "static",
          contract.id,
        ));
      }
    }
    if (
      httpContractUsesLoopback(contract, input.baseUrl) &&
      input.policy.gateSetup.length === 0
    ) {
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

function commandOutput(result: SandboxCommandResult): string {
  return [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
}

function setupFailure(
  index: number,
  command: string,
  result: SandboxCommandResult,
): PreflightFinding {
  return finding(
    `gateSetup.${index + 1}.failed`,
    "error",
    `gate setup command ${index + 1} failed with exit ${result.exitCode}: ${
      commandOutput(result) || "(no output)"
    }`,
    "setup",
  );
}

async function runPreflightSetup(
  handle: SandboxHandle,
  commands: string[],
): Promise<{ steps: PreflightStep[]; errors: PreflightFinding[] }> {
  const steps: PreflightStep[] = [];
  const errors: PreflightFinding[] = [];

  for (const [index, command] of commands.entries()) {
    const result = await handle.execute(
      command,
      REMOTE_ROOT,
      {},
      SETUP_TIMEOUT_MS,
    );
    steps.push({
      label: `gateSetup.${index + 1}`,
      command,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    });
    if (result.exitCode !== 0) {
      errors.push(setupFailure(index, command, result));
      break;
    }
  }

  return { steps, errors };
}

function shouldBlockGateNetwork(
  contracts: Contract[],
  baseUrl?: string,
): boolean {
  return !contracts.some((contract) => httpContractUsesLoopback(contract, baseUrl));
}

function sandboxError(error: unknown): PreflightFinding {
  return finding(
    "gate.sandbox.error",
    "error",
    error instanceof Error ? error.message : String(error),
    "sandbox",
  );
}

function cleanupFailure(error: unknown): PreflightFinding {
  return finding(
    "gate.cleanup.failed",
    "error",
    `Gate sandbox cleanup failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
    "sandbox",
  );
}

function finalOutcome(
  readinessErrors: PreflightFinding[],
  productFailures: string[],
  gateReport: GateReport | undefined,
): GatePreflightReport["outcome"] {
  if (readinessErrors.length > 0 || productFailures.length > 0) {
    return "not_ready";
  }
  if (gateReport?.outcome === "blocked") return "blocked";
  return "ready";
}

export async function runGatePreflight(
  options: GatePreflightOptions,
): Promise<GatePreflightReport> {
  const environment = options.environment ?? process.env;
  const baseUrl = (options.ctx as { baseUrl?: string }).baseUrl;
  const staticFindings = lintGateReadiness({
    contracts: options.contracts,
    policy: options.policy,
    baseUrl,
  });
  const selectedContracts = options.contracts.map((contract) => contract.id);
  const remoteContracts = options.contracts.filter((contract) =>
    !isHostLocalContract(contract)
  );
  const hostLocalContracts = options.contracts.filter(isHostLocalContract);
  const staticErrors = staticFindings.filter((finding) =>
    finding.severity === "error"
  );

  if (staticErrors.length > 0) {
    return {
      outcome: "not_ready",
      staticFindings,
      setup: [],
      selectedContracts,
      remoteContracts: remoteContracts.map((contract) => contract.id),
      hostLocalContracts: hostLocalContracts.map((contract) => contract.id),
      readinessErrors: staticErrors,
      productFailures: [],
    };
  }

  if (remoteContracts.length === 0) {
    return {
      outcome: "ready",
      staticFindings,
      setup: [],
      selectedContracts,
      remoteContracts: [],
      hostLocalContracts: hostLocalContracts.map((contract) => contract.id),
      readinessErrors: [],
      productFailures: [],
    };
  }

  let gateSnapshot: string | undefined;
  let handle: SandboxHandle | undefined;
  let setup: PreflightStep[] = [];
  let gateReport: GateReport | undefined;
  let retained = false;
  const readinessErrors: PreflightFinding[] = [];
  const productFailures: string[] = [];

  try {
    gateSnapshot = getGateSnapshot(environment);
    const baseline = captureWorkspace(options.root, options.policy);
    handle = await options.provider.create({
      role: "gate",
      snapshot: gateSnapshot,
      envVars: {},
      ephemeral: true,
    });
    await handle.upload([...baseline.files.values()], REMOTE_ROOT);
    const mutablePaths = new Set(
      agentVisibleFiles(baseline, options.policy).map((file) => file.path),
    );
    const protectedFiles = [...baseline.files.values()].filter((file) =>
      !mutablePaths.has(file.path)
    );
    if (protectedFiles.length > 0) {
      await handle.verify(protectedFiles, REMOTE_ROOT);
    }

    const setupResult = await runPreflightSetup(
      handle,
      options.policy.gateSetup,
    );
    setup = setupResult.steps;
    readinessErrors.push(...setupResult.errors);

    if (readinessErrors.length === 0) {
      if (shouldBlockGateNetwork(remoteContracts, baseUrl)) {
        await handle.setNetworkBlocked(true);
      }
      gateReport = await options.gate.run(remoteContracts, {
        ...options.ctx,
        cwd: REMOTE_ROOT,
        execution: createDaytonaExecutionTarget(handle, REMOTE_ROOT),
      });
      const classified = classifyGateReportReadiness(gateReport);
      readinessErrors.push(...classified.readinessErrors);
      productFailures.push(...classified.productFailures);
      if (protectedFiles.length > 0) {
        await handle.verify(protectedFiles, REMOTE_ROOT);
      }
    }
  } catch (error) {
    readinessErrors.push(sandboxError(error));
  } finally {
    if (handle) {
      const retainOnFailure = options.retainOnFailure === true &&
        (readinessErrors.length > 0 || productFailures.length > 0);
      if (retainOnFailure) {
        retained = true;
      } else {
        try {
          await handle.delete();
        } catch (error) {
          retained = true;
          readinessErrors.push(cleanupFailure(error));
        }
      }
    }
  }

  return {
    outcome: finalOutcome(readinessErrors, productFailures, gateReport),
    staticFindings,
    setup,
    selectedContracts,
    remoteContracts: remoteContracts.map((contract) => contract.id),
    hostLocalContracts: hostLocalContracts.map((contract) => contract.id),
    ...(gateReport ? { gateReport } : {}),
    readinessErrors,
    productFailures,
    ...(handle && gateSnapshot
      ? { sandbox: { id: handle.id, snapshot: gateSnapshot, retained } }
      : {}),
  };
}

export function renderGatePreflightJson(report: GatePreflightReport): string {
  return JSON.stringify(report, null, 2);
}

export function renderGatePreflightPretty(report: GatePreflightReport): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("Harness Gate Preflight");
  lines.push(
    `selected ${report.selectedContracts.length} contracts; ` +
      `remote ${report.remoteContracts.length}; ` +
      `host-local ${report.hostLocalContracts.length}`,
  );
  lines.push(`outcome: ${report.outcome}`);
  if (report.sandbox) {
    lines.push(
      `sandbox: ${report.sandbox.id} ` +
        `snapshot=${report.sandbox.snapshot} ` +
        `retained=${report.sandbox.retained}`,
    );
  }
  for (const finding of report.staticFindings) {
    lines.push(`[${finding.severity}] ${finding.id}: ${finding.message}`);
  }
  for (const step of report.setup) {
    lines.push(`[setup] ${step.label} exit=${step.exitCode}: ${step.command}`);
  }
  for (const finding of report.readinessErrors) {
    lines.push(`[readiness] ${finding.id}: ${finding.message}`);
  }
  for (const id of report.productFailures) {
    lines.push(`[product-red] ${id}`);
  }
  if (report.hostLocalContracts.length > 0) {
    lines.push(
      "[info] host-local contracts are not covered by Gate sandbox preflight: " +
        report.hostLocalContracts.join(", "),
    );
  }
  lines.push("");
  return lines.join("\n");
}

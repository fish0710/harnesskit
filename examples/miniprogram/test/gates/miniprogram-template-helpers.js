import { createRequire } from "node:module";

const automator = createRequire(import.meta.url)("miniprogram-automator");

export function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function connectMiniProgram({ attempts = 10, intervalMs = 1000 } = {}) {
  const wsEndpoint = requireEnv("HARNESS_MINIPROGRAM_WS_ENDPOINT");
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await automator.connect({ wsEndpoint });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw lastError;
}

export async function relaunchAndWait(miniProgram, route, readySelector) {
  const page = await miniProgram.reLaunch(route);
  await page.waitFor(readySelector);
  return page;
}

export async function expectElement(page, selector) {
  const element = await page.$(selector);
  if (!element) throw new Error(`missing element: ${selector}`);
  return element;
}

export async function expectText(page, selector, expected) {
  const element = await expectElement(page, selector);
  const actual = await element.text();
  if (actual !== expected) {
    throw new Error(`unexpected text for ${selector}: expected ${expected}, got ${actual}`);
  }
  return actual;
}

export async function inputText(page, selector, value) {
  const element = await expectElement(page, selector);
  await element.input(value);
  return element;
}

export async function tapElement(page, selector) {
  const element = await expectElement(page, selector);
  await element.tap();
  return element;
}

export async function triggerElement(page, selector, event = "click", detail = {}) {
  const element = await expectElement(page, selector);
  await element.trigger(event, detail);
  return element;
}

export async function waitForText(page, selector, expected, { attempts = 20, intervalMs = 500 } = {}) {
  let lastActual = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const element = await page.$(selector);
    if (element) {
      lastActual = await element.text();
      if (lastActual === expected) return lastActual;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out waiting for ${selector}: expected ${expected}, got ${lastActual}`);
}

export async function expectCurrentRoute(miniProgram, expectedPath) {
  const page = await miniProgram.currentPage();
  if (page.path !== expectedPath) {
    throw new Error(`unexpected route: expected ${expectedPath}, got ${page.path}`);
  }
  return page;
}

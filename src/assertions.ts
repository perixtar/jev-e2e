import type { Locator, Page } from 'playwright';
import { BlockedError, type Assertion, type CheckResult, type Target } from './types.js';
import { setTimeout as delay } from 'node:timers/promises';

function record(page: Page, text: string): Locator {
  return page.getByText(text, { exact: true }).locator('xpath=ancestor::*[self::li or self::tr or self::article or @role="row" or @role="listitem"][1]');
}
export function assertionLocator(page: Page, target: Target): Locator {
  const scope = target.within?.startsWith('record:') ? record(page, target.within.slice(7)) : target.within ? page.getByRole('region', { name: target.within, exact: true }) : page;
  if (target.by === 'record') {
    if (target.within) return scope.getByText(target.text, { exact: true }).locator('xpath=ancestor::*[self::li or self::tr or self::article or @role="row" or @role="listitem"][1]');
    return record(page, target.text);
  }
  if (target.by === 'label') {
    const literal = target.text.includes("'") ? `concat(${target.text.split("'").map(part => `'${part}'`).join(',"\'",')})` : `'${target.text}'`;
    // Wrapped native selects can include option text in their computed label.
    const wrapped = scope.locator(`xpath=.//label[normalize-space(text())=${literal}]`).locator('input,textarea,select');
    return scope.getByLabel(target.text, { exact: true }).or(wrapped);
  }
  if (target.by === 'role') return scope.getByRole(target.role!, { name: target.text, exact: true });
  return scope.getByText(target.text, { exact: true });
}

export function parseNumber(value: string): number | null {
  const normalized = value.trim().replace(/^(-?)[$€£]\s*/, '$1');
  if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(normalized)) return null;
  const result = Number(normalized.replaceAll(',', '')); return Number.isFinite(result) ? result : null;
}

async function read(page: Page, assertion: Assertion): Promise<string | number | boolean | null> {
  if (assertion.kind === 'url') return new URL(page.url()).pathname;
  const target = assertion.target!;
  if (target.within) {
    const scope = target.within.startsWith('record:') ? record(page, target.within.slice(7)) : page.getByRole('region', { name: target.within, exact: true });
    const scopes = await scope.filter({ visible: true }).count();
    if (scopes !== 1) throw new BlockedError('The assertion scope is missing or ambiguous; absence inside it cannot be established.');
  }
  const locator = assertionLocator(page, target).filter({ visible: true });
  const count = await locator.count();
  if (target.by === 'record' && count === 0) {
    const collections = await page.locator('ul,ol,table,article,[role="list"],[role="table"],[role="grid"],[role="listitem"]').count();
    if (!collections || await page.getByText(target.text, { exact: true }).filter({ visible: true }).count() > 0) throw new BlockedError('The page does not expose a semantic record collection for this exact entity.');
  }
  if (assertion.kind === 'visible' || assertion.kind === 'absent') return count > 0;
  if (assertion.kind === 'count') return count;
  if (count === 0) return null;
  if (count > 1) throw new BlockedError('An assertion target is ambiguous; specify an exact label, role, or record context.');
  if (assertion.kind === 'checked') return locator.isChecked({ timeout: 1000 });
  if (assertion.kind === 'value') {
    const tag = await locator.evaluate(element => element.tagName.toLowerCase());
    return tag === 'select' ? locator.evaluate(element => [...(element as HTMLSelectElement).selectedOptions].map(option => option.label).join(', ')) : locator.inputValue({ timeout: 1000 });
  }
  const raw = target.by === 'label' ? await locator.inputValue({ timeout: 1000 }) : await locator.innerText({ timeout: 1000 });
  return parseNumber(raw);
}

export async function checkAssertion(page: Page, assertion: Assertion, signal: AbortSignal, timeoutMs = 2000): Promise<CheckResult> {
  const deadline = Date.now() + timeoutMs; let observed: CheckResult['observed'] = null;
  do {
    signal.throwIfAborted();
    try { observed = await read(page, assertion); }
    catch (error) { if (error instanceof BlockedError) throw error; throw new BlockedError('Could not read the assertion target. Use a supported, unambiguous target.'); }
    const expected = assertion.kind === 'absent' ? false : assertion.expected;
    if (observed === expected) return { assertion, passed: true, observed };
    if (Date.now() >= deadline) break;
    await delay(100, undefined, { signal });
  } while (true);
  return { assertion, passed: false, observed, reason: observed === null ? 'Expected target was not present or its value could not be parsed.' : 'Observed value did not match the required expectation.' };
}

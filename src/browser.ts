import { randomUUID } from 'node:crypto';
import type { ElementHandle, Page } from 'playwright';
import { redact, sanitize } from './config.js';
import { BlockedError, type Control, type Snapshot, type Step, type FlowAction } from './types.js';

export type Observation = Snapshot & { handles: Map<string, ElementHandle<HTMLElement | SVGElement>> };

export async function observe(page: Page, secrets: string[]): Promise<Observation> {
  const prefix = randomUUID().slice(0, 8);
  const raw = await page.evaluate((prefix) => {
    const visible = (element: Element) => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'; };
    const elements = [...document.querySelectorAll<HTMLElement>('button,a[href],input,textarea,select,[role="button"],[role="link"],[role="checkbox"]')].filter(visible).slice(0, 240);
    const controls = elements.map((element, index) => {
      const id = `${prefix}-${index}`; element.setAttribute('data-jev-e2e-id', id);
      const tag = element.tagName.toLowerCase(); const type = element.getAttribute('type')?.toLowerCase() ?? '';
      const labels = 'labels' in element ? [...((element as HTMLInputElement).labels ?? [])].map(label => { const copy = label.cloneNode(true) as HTMLElement; copy.querySelectorAll('input,select,textarea,button').forEach(child => child.remove()); return copy.textContent; }).join(' ') : '';
      const labelled = (element.getAttribute('aria-labelledby') ?? '').split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ');
      const label = (element.getAttribute('aria-label') || labelled.trim() || labels.trim() || element.getAttribute('placeholder') || element.textContent || element.getAttribute('title') || element.getAttribute('name') || '').replace(/\s+/g, ' ').trim().slice(0, 240);
      const role = element.getAttribute('role') || (tag === 'button' || ['submit', 'button'].includes(type) ? 'button' : tag === 'a' ? 'link' : tag === 'select' ? 'combobox' : type === 'checkbox' ? 'checkbox' : 'textbox');
      const owner = element.closest('li,tr,[role="listitem"],[role="row"],form,[role="dialog"],section') ?? element.parentElement;
      const context = (owner?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
      const disabled = element.matches(':disabled,[aria-disabled="true"]') || Boolean(element.closest('[aria-disabled="true"]')) || element.getAttribute('readonly') !== null;
      const checked = type === 'checkbox' ? (element as HTMLInputElement).checked : role === 'checkbox' ? element.getAttribute('aria-checked') === 'true' : null;
      const options = tag === 'select' ? [...(element as HTMLSelectElement).options].map(option => option.label).slice(0, 80) : [];
      return { id, tag, role, label, context, type, disabled, checked, options, fingerprint: JSON.stringify([tag, type, role, label, context]) };
    });
    return { text: document.body.innerText.slice(0, 10000), controls };
  }, prefix);
  const handles = new Map<string, ElementHandle<HTMLElement | SVGElement>>();
  for (const control of raw.controls) {
    const handle = await page.locator(`[data-jev-e2e-id="${control.id}"]`).elementHandle();
    if (handle) handles.set(control.id, handle);
  }
  const url = new URL(page.url());
  return {
    url: redact(`${url.origin}${url.pathname}`, secrets), text: redact(raw.text, secrets),
    controls: raw.controls.map(control => ({ ...sanitize(control, secrets), fingerprint: control.fingerprint })), handles,
  };
}

export async function disposeObservation(observation: Observation): Promise<void> {
  await Promise.allSettled([...observation.handles.values()].map(handle => handle.dispose()));
}

export function replayControl(action: FlowAction, observation: Observation): Control | null {
  if (!action.control) return null;
  const matches = observation.controls.filter(control => !control.disabled && control.tag === action.control!.tag && control.role === action.control!.role && control.label === action.control!.label && control.type === action.control!.type && control.context === action.control!.context);
  return matches.length === 1 ? matches[0] : null;
}

export async function execute(page: Page, observation: Observation, control: Control, step: Step, value: string | null, signal: AbortSignal, origins: Set<string>): Promise<void> {
  signal.throwIfAborted();
  if (!origins.has(new URL(page.url()).origin)) throw new BlockedError('The app left its allowed origins.');
  const handle = observation.handles.get(control.id);
  if (!handle) throw new BlockedError('Selected control no longer exists.');
  const current = await handle.evaluate(element => {
    if (!element.isConnected) return null;
    const tag = element.tagName.toLowerCase(); const type = element.getAttribute('type')?.toLowerCase() ?? '';
    const labels = 'labels' in element ? [...((element as HTMLInputElement).labels ?? [])].map(label => { const copy = label.cloneNode(true) as HTMLElement; copy.querySelectorAll('input,select,textarea,button').forEach(child => child.remove()); return copy.textContent; }).join(' ') : '';
    const labelled = (element.getAttribute('aria-labelledby') ?? '').split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ');
    const label = (element.getAttribute('aria-label') || labelled.trim() || labels.trim() || element.getAttribute('placeholder') || element.textContent || element.getAttribute('title') || element.getAttribute('name') || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    const role = element.getAttribute('role') || (tag === 'button' || ['submit', 'button'].includes(type) ? 'button' : tag === 'a' ? 'link' : tag === 'select' ? 'combobox' : type === 'checkbox' ? 'checkbox' : 'textbox');
    const owner = element.closest('li,tr,[role="listitem"],[role="row"],form,[role="dialog"],section') ?? element.parentElement;
    const context = (owner?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    return JSON.stringify([tag, type, role, label, context]);
  });
  if (current !== control.fingerprint || !await handle.isVisible() || !await handle.isEnabled()) throw new BlockedError('Selected control was replaced or changed before action dispatch.');
  signal.throwIfAborted();
  try {
    const settings = { timeout: 4000 };
    if (step.action === 'click') await handle.click(settings);
    else if (step.action === 'fill') {
      if (value === null) throw new BlockedError('Missing exact input value.');
      await handle.fill(value, settings);
      if (await handle.inputValue(settings) !== value) throw new BlockedError('The field did not retain the exact supplied value.');
    } else if (step.action === 'select') {
      if (value === null) throw new BlockedError('Missing selected option.');
      if (!control.options.includes(value)) throw new BlockedError('The supplied option is not present in the native select.');
      await handle.selectOption({ label: value }, settings);
      const selected = await handle.evaluate(element => [...(element as HTMLSelectElement).selectedOptions].map(option => option.label));
      if (selected.length !== 1 || selected[0] !== value) throw new BlockedError('The selected label did not match the supplied value.');
    } else if (step.action === 'check' || step.action === 'uncheck') {
      await handle.setChecked(step.action === 'check', settings);
      if (await handle.isChecked() !== (step.action === 'check')) throw new BlockedError('The checkbox did not retain the required state.');
    }
  } catch (error) {
    if (error instanceof BlockedError) throw error;
    // A dispatched mutation can have an unknown outcome. Never repeat it automatically.
    throw new BlockedError(signal.aborted ? 'Run canceled or timed out.' : 'Browser action could not complete; its mutation outcome may be unknown. It was not retried.');
  }
  signal.throwIfAborted();
}

export function savedControl(control: Control): FlowAction['control'] {
  return { tag: control.tag, role: control.role, label: control.label, context: control.context, type: control.type };
}

export async function maskedScreenshot(page: Page, fixtureSecrets: string[], path: string): Promise<void> {
  const masks = [page.locator('input,textarea,[contenteditable="true"],[data-private]')];
  for (const secret of fixtureSecrets) if (secret) masks.push(page.getByText(secret, { exact: false }));
  await page.screenshot({ path, fullPage: false, mask: masks, timeout: 3000, animations: 'disabled' });
}

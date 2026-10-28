// Applies saved display preferences at once (MILESTONE-2 M2-16). Language and theme go through the controller's own
// header controls (the EN and ID buttons and the theme button), so its state, the data source language and the
// generated views follow; the density is the `data-density` attribute of the app root, which the controller sets from
// the boot settings only. Boot applies all three on the next start (M2-01 C.3).
import type { HostContext } from '../types';
import { DENSITIES } from './model';
import type { Preferences } from './model';

/** The smallest part of an element this module uses (the DOM, or a fake in unit tests). */
export interface RootLike {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  querySelector(selector: string): { querySelectorAll(selector: string): ArrayLike<ButtonLike>; querySelector(selector: string): ButtonLike | null } | null;
}
export interface ButtonLike {
  textContent: string | null;
  click(): void;
}

/** The `.mscd` root around the host layer, or null outside a browser. */
export function appRoot(ctx: HostContext): RootLike | null {
  const layer = ctx.layer();
  const root = layer && typeof layer.closest === 'function' ? layer.closest('.mscd') : null;
  if (root) return root as unknown as RootLike;
  return typeof document === 'undefined' ? null : (document.querySelector('.mscd') as unknown as RootLike | null);
}

/** The density the app shows now. */
export function currentDensity(root: RootLike | null): Preferences['density'] {
  const value = root?.getAttribute('data-density');
  return (DENSITIES as readonly string[]).includes(value ?? '') ? (value as Preferences['density']) : 'comfortable';
}

/** Applies the preferences that differ from what the app shows. */
export function applyDisplay(root: RootLike | null, prefs: Preferences, current: { lang: string; theme: string }): void {
  if (!root) return;
  const header = root.querySelector('header');
  if (header && prefs.theme !== current.theme) {
    header.querySelector('button[title="Theme"], button[title="Tema"]')?.click();
  }
  if (header && prefs.language !== current.lang) {
    const label = prefs.language === 'id' ? 'ID' : 'EN';
    const buttons = Array.from(header.querySelectorAll('button'));
    buttons.find((b) => (b.textContent ?? '').trim() === label)?.click();
  }
  if (root.getAttribute('data-density') !== prefs.density) root.setAttribute('data-density', prefs.density);
}

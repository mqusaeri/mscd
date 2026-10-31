// The organisation switch the address asked for (MILESTONE-2 M2-20), kept for this page only.
//
// An address can name another organisation than the one of the session (a copied address, Back across an
// organisation switch). The app then switches organisation. When that organisation asks for a new sign-in (D-26),
// the boot router shows the sign-in page in the same page and, when the person cancels it, opens the app again with
// the old session and the same address. The slug kept here tells that app that this switch was already tried, so it
// keeps the session's organisation and corrects the address instead of asking again.
//
// The slug lives in the memory of the page, not in the browser's storage: the boot router opens the app again without
// loading the page, while every new page (a typed or pasted address, a reload, a return from another site) starts
// without it. So a person who left that sign-in page for another address is asked again by the next address of the
// organisation, and nothing is left behind in the tab.

let tried: string | null = null;

/** The organisation slug whose switch was tried in this page, or null. */
export function orgTried(): string | null {
  return tried;
}

/** Remembers that a switch to this organisation is under way. */
export function rememberOrgTried(slug: string): void {
  tried = slug;
}

/** Forgets the tried switch. */
export function forgetOrgTried(): void {
  tried = null;
}

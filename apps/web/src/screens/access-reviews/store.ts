// A change counter of the access review screens (MILESTONE-3 M3-07): every successful command bumps it, so the lists
// and the review pages of Access reviews and Access review of this system read again.
let version = 0;
const listeners = new Set<() => void>();

export function subscribeAccessReviews(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const accessReviewsVersion = (): number => version;

export function noteAccessReviewsChanged(): void {
  version += 1;
  for (const l of [...listeners]) l();
}

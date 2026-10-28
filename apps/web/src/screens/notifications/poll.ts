// When the notification bell reads the unread count again (MILESTONE-2 M2-16). Every request made with a session moves
// the session's idle expiry forward (F.1: 60 minutes for staff, 30 for guest auditors), so a count read on a timer alone
// would keep an unattended session alive until its absolute limit. The bell therefore reads the count on its timer only
// while the page is visible and the person used the keyboard, the mouse, the wheel or the screen within IDLE_AFTER_MS,
// which is well under every idle timeout. After a quiet spell the timer reads nothing; the first input reads the count
// at once, and the timer goes on from there.
import { IDLE_AFTER_MS, POLL_MS } from './model';

/** Input that counts as the person being at the page. Mouse movement alone does not count. */
export const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

type Target = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

export interface PollOptions {
  /** Time between reads while the person is active; default POLL_MS. */
  every?: number;
  /** Time without input after which the timer stops reading; default IDLE_AFTER_MS. */
  idleAfter?: number;
  /** Where input is listened for; default the window (none outside a browser). */
  target?: Target | null;
  /** Whether the page is hidden; default `document.hidden`. */
  hidden?: () => boolean;
}

const defaultTarget = (): Target | null => (typeof window === 'undefined' ? null : window);
const defaultHidden = (): boolean => typeof document !== 'undefined' && document.hidden;
const LISTEN: AddEventListenerOptions = { capture: true, passive: true };

/**
 * Calls `refresh` every `every` milliseconds while the page is visible and the last input is less than `idleAfter`
 * old, and once on the first input after a skipped read. The page load counts as input. Returns the stop function.
 */
export function startPolling(refresh: () => void, options: PollOptions = {}): () => void {
  const every = options.every ?? POLL_MS;
  const idleAfter = options.idleAfter ?? IDLE_AFTER_MS;
  const target = options.target === undefined ? defaultTarget() : options.target;
  const hidden = options.hidden ?? defaultHidden;
  let lastInput = Date.now();
  let missed = false;
  const tick = () => {
    if (!hidden() && Date.now() - lastInput < idleAfter) refresh();
    else missed = true;
  };
  const onInput = () => {
    lastInput = Date.now();
    if (missed && !hidden()) {
      missed = false;
      refresh();
    }
  };
  const timer = setInterval(tick, every);
  for (const type of ACTIVITY_EVENTS) target?.addEventListener(type, onInput, LISTEN);
  return () => {
    clearInterval(timer);
    for (const type of ACTIVITY_EVENTS) target?.removeEventListener(type, onInput, LISTEN);
  };
}

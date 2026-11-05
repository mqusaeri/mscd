// A hook harness without a DOM (M3-12; shared by the screen unit tests since M3-15): the web unit tests run in Node, so a
// component is called as a function with a stand-in for React's hook dispatcher. Its hooks keep their state between
// calls by call order, effects run after each call when their dependencies change, and the returned element tree is
// searched for the handlers a click would run.
import * as React from 'react';

type Slot = { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void };
type Dispatcher = Record<string, unknown>;

/** React's current hook dispatcher (React 18 internals; React 19 renamed them). */
const dispatcherRef: { get(): unknown; set(d: unknown): void } = (() => {
  const internals = React as unknown as {
    __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED?: { ReactCurrentDispatcher: { current: unknown } };
    __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: { H: unknown };
  };
  const r18 = internals.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
  if (r18) return { get: () => r18.ReactCurrentDispatcher.current, set: (d) => { r18.ReactCurrentDispatcher.current = d; } };
  const r19 = internals.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE!;
  return { get: () => r19.H, set: (d) => { r19.H = d; } };
})();

const sameDeps = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined) =>
  !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

/** A function component with its hook state, rendered by calling it until no state changes. */
export function hooked<P>(component: (props: P) => React.ReactNode) {
  const slots: Slot[] = [];
  let dirty = false;
  const renderOnce = (props: P): React.ReactNode => {
    let index = 0;
    const effects: (() => void)[] = [];
    const effect = (fn: () => void | (() => void), deps?: readonly unknown[]) => {
      const k = index++;
      const prev = slots[k];
      if (prev && deps && sameDeps(prev.deps, deps)) return;
      slots[k] = { deps, cleanup: prev?.cleanup };
      effects.push(() => {
        slots[k]!.cleanup?.();
        const cleanup = fn();
        slots[k]!.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
      });
    };
    const memo = <T,>(make: () => T, deps: readonly unknown[]) => {
      const k = index++;
      const prev = slots[k];
      if (prev && sameDeps(prev.deps, deps)) return prev.value as T;
      const value = make();
      slots[k] = { value, deps };
      return value;
    };
    const dispatcher: Dispatcher = {
      useState: (initial: unknown) => {
        const k = index++;
        if (!slots[k]) slots[k] = { value: typeof initial === 'function' ? (initial as () => unknown)() : initial };
        const slot = slots[k]!;
        const set = (next: unknown) => {
          const value = typeof next === 'function' ? (next as (v: unknown) => unknown)(slot.value) : next;
          if (!Object.is(value, slot.value)) {
            slot.value = value;
            dirty = true;
          }
        };
        return [slot.value, set];
      },
      useRef: (initial: unknown) => {
        const k = index++;
        if (!slots[k]) slots[k] = { value: { current: initial } };
        return slots[k]!.value;
      },
      useEffect: effect,
      useLayoutEffect: effect,
      useMemo: memo,
      useCallback: (fn: unknown, deps: readonly unknown[]) => memo(() => fn, deps),
      useContext: (context: { _currentValue: unknown }) => context._currentValue,
    };
    const before = dispatcherRef.get();
    dispatcherRef.set(dispatcher);
    let tree: React.ReactNode;
    try {
      tree = component(props);
    } finally {
      dispatcherRef.set(before);
    }
    for (const run of effects) run();
    return tree;
  };
  return {
    /** Renders with `props` until the state settles, as React would after each state change. */
    render(props: P): React.ReactNode {
      for (let round = 0; round < 10; round += 1) {
        dirty = false;
        const tree = renderOnce(props);
        if (!dirty) return tree;
      }
      throw new Error('The component does not settle');
    },
  };
}

export type Found = React.ReactElement<Record<string, unknown>>;

/** Every element of a tree (props searched as well: children, footer and other element props), in order. */
export function elementsOf(node: unknown, out: Found[] = []): Found[] {
  if (Array.isArray(node)) node.forEach((n) => elementsOf(n, out));
  else if (React.isValidElement(node)) {
    out.push(node as Found);
    for (const value of Object.values((node as Found).props)) elementsOf(value, out);
  }
  return out;
}

/** The one element of a tree that matches. */
export function one(tree: React.ReactNode, match: (e: Found) => boolean, what: string): Found {
  const found = elementsOf(tree).filter(match);
  if (found.length !== 1) throw new Error(`${found.length} elements are ${what}`);
  return found[0]!;
}

export const button = (text: string) => (e: Found) => typeof e.props.onClick === 'function' && e.props.children === text;
export const field = (name: string) => (e: Found) => e.props.name === name && typeof e.props.onChange === 'function';

// src/insights/RightExtrasContext.jsx
import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';

/**
 * Descriptor-based API for the right-side rail (Insights/Agenda/etc).
 * We store a *data object* instead of JSX so widgets don't remount
 * when only their props (e.g. businessId, module) change.
 *
 * Example descriptor:
 *   { type: 'agenda', props: { businessId: '...', module: 'tax' } }
 */
const initialDescriptor = { type: null }; // nothing shown by default

const Ctx = createContext({
  extras: initialDescriptor,
  setExtras: () => {},
  // Back-compat with old code that passed <AgendaWidget .../>
  setRightExtras: () => {},
});

// Shallow compare so we don't flip state if nothing actually changed
function shallowEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    const av = a[k];
    const bv = b[k];
    if (av && typeof av === 'object' && bv && typeof bv === 'object') {
      const aKeys = Object.keys(av);
      const bKeys = Object.keys(bv);
      if (aKeys.length !== bKeys.length) return false;
      for (const pk of aKeys) {
        if (av[pk] !== bv[pk]) return false;
      }
    } else if (av !== bv) {
      return false;
    }
  }
  return true;
}

export function RightExtrasProvider({ children }) {
  const [extras, _set] = useState(initialDescriptor);

  const setExtras = useCallback((next) => {
    const normalized =
      next && typeof next === 'object' ? next : initialDescriptor;
    _set((prev) => (shallowEqual(prev, normalized) ? prev : normalized));
  }, []);

  /**
   * Backward-compat helper:
   * If somebody calls setRightExtras(<AgendaWidget businessId="..." module="..."/>)
   * we translate that JSX element into a descriptor exactly once, so the rail can
   * render a single Agenda instance and only update its props later.
   */
  const setRightExtras = useCallback(
    (nodeOrDescriptor) => {
      if (!nodeOrDescriptor) {
        setExtras(initialDescriptor);
        return;
      }
      // If it's already a descriptor, accept it:
      if (
        nodeOrDescriptor &&
        typeof nodeOrDescriptor === 'object' &&
        'type' in nodeOrDescriptor &&
        !nodeOrDescriptor.$$typeof // not a React element
      ) {
        setExtras(nodeOrDescriptor);
        return;
      }
      // Best-effort JSX -> descriptor mapping (legacy support)
      const el = nodeOrDescriptor;
      const compName = el?.type?.displayName || el?.type?.name || '';
      if (compName === 'AgendaWidget' && el?.props) {
        setExtras({
          type: 'agenda',
          props: {
            businessId: el.props.businessId,
            module: el.props.module,
          },
        });
      } else {
        // Unknown element → just clear, or extend here for more widget types
        setExtras(initialDescriptor);
      }
    },
    [setExtras]
  );

  const value = useMemo(
    () => ({ extras, setExtras, setRightExtras }),
    [extras, setExtras, setRightExtras]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useRightExtras = () => useContext(Ctx);

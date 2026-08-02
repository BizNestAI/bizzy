// File: src/hooks/useModuleTheme.js
import { useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { dashboardThemeMap as externalMap } from '../utils/themeMap.js';

// Tailwind class bundles for each neon theme
const THEME_CLASSES = {
  green: {
    textClass: 'text-neon-green',
    bgClass: 'bg-app',
    borderColorClass: 'border-neon-green',
    shadowClass: 'shadow-neon-green',
    ringClass: 'ring-neon-green',
  },
  neutral: {
    textClass: 'text-white',
    bgClass: 'bg-app',
    borderColorClass: 'border-white/10',
    shadowClass: 'shadow-lg',
    ringClass: 'ring-white/20',
  },
};

// Local default route → unified theme
const LOCAL_ROUTE_TO_THEME = {
  bizzy: 'green',
  accounting: 'green',
  financials: 'green',
  marketing: 'green',
  tax: 'green',
  investments: 'green',
};

// Normalize whatever we receive (pathname or module key) into a module key
function normalizeModuleKey(input) {
  if (!input) return 'bizzy';
  if (input.includes('/')) {
    const seg = input.split('/')[2] || '';
    const key = seg.toLowerCase() || 'bizzy';
    if (key === 'bizzi') return 'bizzy';
    if (key === 'bizzi-docs') return 'docs';
    return key;
  }
  const key = input.toLowerCase();
  if (key === 'bizzi') return 'bizzy';
  if (key === 'bizzi-docs') return 'docs';
  return key;
}

export default function useModuleTheme(explicitModule = null) {
  const location = useLocation();

  return useMemo(() => {
    const moduleKey = normalizeModuleKey(explicitModule ?? location.pathname);
    const normalized = moduleKey === 'financials' ? 'accounting' : moduleKey;

    const themeKey =
      (externalMap && externalMap[normalized]) ||
      LOCAL_ROUTE_TO_THEME[normalized] ||
      'green';

    return THEME_CLASSES[themeKey] || THEME_CLASSES.neutral;
  }, [explicitModule, location.pathname]);
}

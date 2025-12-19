// File: src/hooks/useModuleTheme.js
import { useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { dashboardThemeMap as externalMap } from '../utils/themeMap.js';

// Tailwind class bundles for each neon theme
const THEME_CLASSES = {
  pink: {
    textClass: 'text-neon-pink',
    bgClass: 'bg-app',
    borderColorClass: 'border-neon-pink',
    shadowClass: 'shadow-neon-pink',
    ringClass: 'ring-neon-pink',
  },
  green: {
    textClass: 'text-neon-green',
    bgClass: 'bg-app',
    borderColorClass: 'border-neon-green',
    shadowClass: 'shadow-neon-green',
    ringClass: 'ring-neon-green',
  },
  blue: {
    textClass: 'text-neon-blue',
    bgClass: 'bg-app',
    borderColorClass: 'border-neon-blue',
    shadowClass: 'shadow-neon-blue',
    ringClass: 'ring-neon-blue',
  },
  gold: {
    textClass: 'text-neon-gold',
    bgClass: 'bg-app',
    borderColorClass: 'border-neon-gold',
    shadowClass: 'shadow-neon-gold',
    ringClass: 'ring-neon-gold',
  },
  purple: {
    textClass: 'text-neon-purple',
    bgClass: 'bg-app',
    borderColorClass: 'border-neon-purple',
    shadowClass: 'shadow-neon-purple',
    ringClass: 'ring-neon-purple',
  },
  // fallback (rare)
  neutral: {
    textClass: 'text-white',
    bgClass: 'bg-app',
    borderColorClass: 'border-white/10',
    shadowClass: 'shadow-lg',
    ringClass: 'ring-white/20',
  },
};

// Local default route → theme mapping
const LOCAL_ROUTE_TO_THEME = {
  bizzy: 'pink',
  accounting: 'green',
  financials: 'green', // alias → accounting
  marketing: 'blue',
  tax: 'gold',
  investments: 'purple',
};

// Normalize whatever we receive (pathname or module key) into a module key
function normalizeModuleKey(input) {
  if (!input) return 'bizzy';
  if (input.includes('/')) {
    const seg = input.split('/')[2] || '';
    return seg.toLowerCase() || 'bizzy';
  }
  return input.toLowerCase();
}

export default function useModuleTheme(explicitModule = null) {
  const location = useLocation();

  return useMemo(() => {
    const moduleKey = normalizeModuleKey(explicitModule ?? location.pathname);
    const normalized = moduleKey === 'financials' ? 'accounting' : moduleKey;

    const themeKey =
      (externalMap && externalMap[normalized]) ||
      LOCAL_ROUTE_TO_THEME[normalized] ||
      'pink';

    return THEME_CLASSES[themeKey] || THEME_CLASSES.neutral;
  }, [explicitModule, location.pathname]);
}

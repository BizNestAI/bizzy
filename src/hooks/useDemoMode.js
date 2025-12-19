import { useEffect, useState } from 'react';
import { getDemoMode } from '../services/demo/demoClient.js';

export default function useDemoMode() {
  const [mode, setMode] = useState(() => getDemoMode() || 'auto');

  useEffect(() => {
    function refresh() {
      setMode(getDemoMode() || 'auto');
    }
    window.addEventListener('bizzy:demo-mode-changed', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('bizzy:demo-mode-changed', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  return mode;
}

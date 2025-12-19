// components/Chrome/DashboardTitleGlow.jsx
import React, { useMemo } from 'react';
import { motion } from 'framer-motion';
import { ChevronDown } from 'lucide-react';
import useModuleTheme from '../../hooks/useModuleTheme';

export default function DashboardTitleGlow({
  label,                // e.g. "Investments Dashboard"
  onClick,              // open dropdown
  className = '',
  accentHexOverride,    // optional direct hex if you want
}) {
  const theme = useModuleTheme(); // your hook already maps by route
  // Choose an accent hex per module (fallbacks)
  const accentHex = useMemo(() => {
    if (accentHexOverride) return accentHexOverride;
    return theme?.accentHex || '#a855f7'; // purple fallback
  }, [theme, accentHexOverride]);

  // Two tones for outer/inner glow
  const accentOuter = useMemo(() => hexToRgba(accentHex, 0.35), [accentHex]);
  const accentInner = useMemo(() => hexToRgba(accentHex, 0.25), [accentHex]);

  return (
    <motion.button
      onClick={onClick}
      initial={{ scale: 0.995 }}
      animate={{ scale: [0.995, 1, 0.995] }}
      transition={{ duration: 3.2, repeat: Infinity, ease: 'easeInOut' }}
      className={[
        // pill container
        'relative inline-flex items-center gap-2 px-4 py-2 rounded-full',
        'bg-black/40 backdrop-blur border border-white/10',
        'text-white shadow-sm',
        'hover:shadow-lg hover:border-white/20',
        'focus:outline-none focus:ring-2 focus:ring-white/30',
        'animate-pulse-glow',
        className
      ].join(' ')}
      style={{
        // feed CSS vars for the glow animation
        ['--accent-outer']: accentOuter,
        ['--accent-inner']: accentInner,
      }}
    >
      {/* subtle outer halo */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 rounded-full"
        style={{ boxShadow: `0 0 40px ${accentOuter}` }}
      />

      {/* sheen on hover */}
      <span aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden rounded-full">
        <span className="absolute top-0 h-full w-1/3 -skew-x-12 opacity-0 group-hover:opacity-40
                          bg-gradient-to-r from-white/0 via-white/20 to-white/0
                          animate-sheen" />
      </span>

      {/* gradient text for a grand feel */}
      <span className="bg-clip-text text-transparent bg-gradient-to-r from-white via-white to-white/80">
        {label}
      </span>

      <ChevronDown className="h-4 w-4 opacity-80" />
    </motion.button>
  );
}

/** utils */
function hexToRgba(hex, alpha = 1) {
  let c = hex.replace('#', '');
  if (c.length === 3) c = c.split('').map(s => s + s).join('');
  const bigint = parseInt(c, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

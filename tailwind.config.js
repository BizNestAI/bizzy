// tailwind.config.js
module.exports = {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}', // Vite
  ],
  darkMode: 'class',
  safelist: [
    'text-neon-pink','border-neon-pink','shadow-neon-pink','ring-neon-pink',
    'text-neon-green','border-neon-green','shadow-neon-green','ring-neon-green',
    'text-neon-blue','border-neon-blue','shadow-neon-blue','ring-neon-blue',
    'text-neon-gold','border-neon-gold','shadow-neon-gold','ring-neon-gold',
    'text-neon-purple','border-neon-purple','shadow-neon-purple','ring-neon-purple',
  ],
  theme: {
    extend: {
      fontFamily: {
        space: ['"IBM Plex Sans"','"Space Grotesk"', 'sans-serif'],
      },

      // Keep legacy neon colors for module themes (no change)
      colors: {
        'neon-pink':   '#FF4EEB',
        'neon-green':  '#00FFB2',
        'neon-blue':   '#3B82F6',
        'neon-gold':   '#FFD700',
        'neon-purple': '#B388FF',

        app: {
          DEFAULT: '#12100F',
          light:   '#151312',
          dark:    '#0F0E0C',
        },
        softWhite: '#f7f1e8',

        // Graphite tokens (CSS variables) — usable directly if you prefer:
        appVars: {
          bg:      'var(--bg)',
          panel:   'var(--panel)',
          sidebar: 'var(--sidebar)',
          text:    'var(--text)',
          muted:   'var(--text-2)',
          accent:  'var(--accent)',
          accent2: 'var(--accent-2)',
        },
      },

      boxShadow: {
        'neon-pink':   '0 0 12px 4px #FF4EEB',
        'neon-green':  '0 0 12px 4px #00FFB2',
        'neon-blue':   '0 0 12px 4px #3B82F6',
        'neon-gold':   '0 0 12px 4px #FFD700',
        'neon-purple': '0 0 12px 4px #B388FF',

        // Graphite card shadow
        'bizzi-card':  'var(--card-shadow)',
      },

      ringColor: {
        'neon-pink':   '#FF4EEB',
        'neon-green':  '#00FFB2',
        'neon-blue':   '#3B82F6',
        'neon-gold':   '#FFD700',
        'neon-purple': '#B388FF',
      },
      borderColor: {
        'neon-pink':   '#FF4EEB',
        'neon-green':  '#00FFB2',
        'neon-blue':   '#3B82F6',
        'neon-gold':   '#FFD700',
        'neon-purple': '#B388FF',
      },

      backgroundImage: {
        'bizzi-accent-hover': 'linear-gradient(90deg, var(--accent), var(--accent-2))',
      },
    },
  },
  plugins: [
    require('tailwind-scrollbar-hide'),
    require('@tailwindcss/typography'),

    // Semantic utility shorthands to avoid sprinkling hex codes
    function ({ addUtilities, addComponents }) {
      addUtilities({
        '.bg-app':        { backgroundColor: 'var(--bg)' },
        '.bg-panel':      { backgroundColor: 'var(--panel)' },
        '.bg-sidebar':    { backgroundColor: 'var(--sidebar)' },
        '.text-primary':  { color: 'var(--text)' },
        '.text-secondary':{ color: 'var(--text-2)' },
        '.shadow-bizzi':  { boxShadow: 'var(--card-shadow)' },
        '.glow-accent':   { boxShadow: '0 0 0 0 rgba(255,78,235,0.16), 0 0 20px rgba(255,78,235,0.12)' },
      });

      addComponents({
        '.btn-accent-hover': {
          backgroundImage: 'linear-gradient(90deg, var(--accent), var(--accent-2))',
          transition: 'filter .2s ease, box-shadow .2s ease, transform .06s ease',
        },
        '.btn-accent-hover:hover': {
          filter: 'brightness(1.03)',
          boxShadow: '0 0 16px rgba(255,78,235,0.18)',
          transform: 'translateY(-0.5px)',
        },
      });
    },
  ],
};

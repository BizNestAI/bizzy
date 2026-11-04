// Shared appearance for the main sidebar and bottom Settings tooltip.
export const NAV_TOOLTIP_CLASS = 'pointer-events-none fixed z-[9999] px-3 py-1 rounded-lg text-[12px] text-white shadow-[0_10px_30px_rgba(0,0,0,0.35)]';
export const NAV_TOOLTIP_STYLE = {
  background: 'rgba(20,22,26,0.95)',
  border: '1px solid rgba(var(--accent-rgb),0.28)',
  boxShadow: '0 0 0 1px rgba(var(--accent-rgb),0.12), 0 12px 30px rgba(0,0,0,0.45), 0 0 12px rgba(var(--accent-rgb),0.2)',
  color: 'rgba(245,247,251,0.95)',
};
export const NAV_TOOLTIP_MOTION = {
  initial: { opacity: 0, x: -4, y: -4, scale: 0.96 },
  animate: { opacity: 1, x: 0, y: 0, scale: 1 },
  exit: { opacity: 0, x: -2, y: -2, scale: 0.96 },
  transition: { duration: 0.2, ease: [0.22, 0.1, 0.25, 1] },
};

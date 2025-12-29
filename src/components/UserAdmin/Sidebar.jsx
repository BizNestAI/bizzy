import React, { useCallback, useMemo, useState, useEffect } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import {
  Brain, DollarSign, Rocket, FileText, TrendingUp,
  Calendar as CalendarIcon, Briefcase, BookOpen, Settings, Mail,
  Activity as ActivityIcon, HeartPulse, Landmark,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { createPortal } from 'react-dom';

import { subSidebarConfig } from '../../utils/subSidebarConfig';
import { useInsightsUnread } from '../../insights/InsightsUnreadContext';

/* ------------------------------ Tabs ------------------------------ */
const tabs = [
  { label: 'Pulse', path: '/dashboard/bizzy' },
  { label: 'Financials', path: '/dashboard/accounting' },
  { label: 'Growth', path: '/dashboard/marketing' },
  { label: 'Jobs', path: '/dashboard/leads-jobs' },
  { label: 'Tax', path: '/dashboard/tax' },
  { label: 'Email', path: '/dashboard/email' },
  { label: 'Scheduling', path: '/dashboard/calendar' },
  { label: 'Activity', path: '/dashboard/activity', tooltip: 'Coming Soon!', disableNavigate: true },
  { label: 'Bizzi Docs', path: '/dashboard/bizzy-docs' },
  { label: 'Meet Bizzi', path: '/dashboard/companion' },
  { label: 'Settings/Sync', path: '/dashboard/settings' },
];

/* -------------------------- Accent palette ------------------------- */
const accentHexMap = {
  bizzy:       '#FF4EEB',
  accounting:  '#00FFB2',
  marketing:   '#3B82F6',
  tax:         '#FFD700',
  investments: '#B388FF',
  email:       '#3CF2FF',
  calendar:    '#BFBFBF',
  scheduling:  '#94a3b8',
  activity:    '#94a3b8',
  ops:         '#94a3b8',
};

function moduleKeyFromLabel(label) {
  const k = label.toLowerCase();
  if (k === 'financials') return 'accounting';
  if (k === 'bizzi') return 'bizzy';
  if (k === 'growth') return 'marketing';
  if (k === 'tax') return 'tax';
  if (k === 'investments') return 'investments';
  if (k === 'email') return 'email';
  if (k === 'bizzi docs') return 'docs';
  if (k === 'meet bizzi') return 'companion';
  if (k === 'settings/sync' || k === 'settings' || k === 'sync') return 'settings';
  if (k === 'scheduling') return 'calendar';
  if (k === 'activity') return 'activity';
  if (k === 'jobs') return 'ops';
  return 'bizzy';
}

/* -------- path -> module helpers -------- */
function moduleKeyFromPath(pathname = '') {
  const seg = (pathname.split('/')[2] || '').toLowerCase();
  if (seg === 'financials' || seg === 'accounting') return 'accounting';
  if (seg === 'growth') return 'marketing';
  if (seg === 'tax') return 'tax';
  if (seg === 'investments') return 'investments';
  if (seg === 'email' || seg === 'inbox') return 'email';
  if (seg === 'scheduling' || seg === 'sch') return 'calendar';
  if (seg === 'activity') return 'activity';
  if (seg === 'leads-jobs' || seg === 'jobs') return 'ops';
  if (seg === 'bizzy-docs' || seg === 'docs') return 'docs';
  if (seg === 'companion') return 'companion';
  if (seg === 'settings' || seg === 'settings-sync' || seg === 'sync') return 'settings';
  if (seg === 'bizzy' || seg === '') return 'bizzy';
  return 'bizzy';
}

/* -------- unread key normalization -------- */
function normalizeUnreadMap(raw = {}) {
  const ALIAS = { inbox: 'email', sch: 'calendar', jobs: 'ops' };
  const totals = {};
  for (const [key, val] of Object.entries(raw)) {
    const [base] = key.split(':'); // drop :business suffixes
    const canonical = ALIAS[base] || base;
    totals[canonical] = (totals[canonical] || 0) + Number(val || 0);
  }
  return totals;
}

const CHROME_TABS = new Set(['Pulse', 'Jobs', 'Bizzi Docs', 'Meet Bizzi', 'Settings/Sync', 'Calendar', 'Scheduling', 'Activity']);
const CHROME_HEX  = '#BFBFBF';
const CHROME_SOFT = 'rgba(191,191,191,0.50)';

function hexToRgba(hex, alpha = 1) {
  let c = (hex || '').replace('#', '');
  if (c.length === 3) c = c.split('').map(s => s + s).join('');
  const n = parseInt(c || '000000', 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
function coloredBadgeStyle(hex) {
  return {
    background: hexToRgba(hex, 0.35),
    border: `1px solid ${hexToRgba(hex, 0.24)}`,
    boxShadow: `0 0 8px ${hexToRgba(hex, 0.24)}`,
    color: '#f8fafc',
  };
}
const neutralBadgeStyle = {
  background: 'rgba(165,167,169,0.20)',
  border: '1px solid rgba(165,167,169,0.28)',
  boxShadow: 'none',
  color: '#e5e7eb',
};

function renderActiveClass(label) {
  const glow = 'shadow-[0_0_6px_1px_rgba(255,255,255,0.18)]'; // softer outer glow
  switch (label) {
    case 'Financials':  return `text-neon-green  ${glow} font-semibold bg-black`;
    case 'Marketing':   return `text-neon-blue   shadow-[0_0_6px_1px_#3B82F6] font-semibold bg-black`;
    case 'Tax':         return `text-neon-gold   ${glow} font-semibold bg-black`;
    case 'Investments': return `text-neon-purple ${glow} font-semibold bg-black`;
    case 'Email':       return `text-white ${glow} font-semibold bg-black`;
    case 'Scheduling':  return `text-white ${glow} font-semibold bg-black`;
    default:            return `text-white ${glow} font-semibold bg-black`;
  }
}
function getHoverClass(label) {
  switch (label) {
    case 'Financials':  return 'hover:shadow-[0_0_5px_1px_#00FFB2]';
    case 'Growth':   return 'hover:shadow-[0_0_5px_1px_#3B82F6]';
    case 'Tax':         return 'hover:shadow-[0_0_5px_1px_#FFD700]';
    case 'Investments': return 'hover:shadow-[0_0_5px_1px_#B388FF]';
    case 'Email':       return 'hover:shadow-[0_0_5px_1px_#3CF2FF]';
    case 'Scheduling':  return 'hover:shadow-[0_0_5px_1px_rgba(191,191,191,0.45)]';
    default:            return 'hover:shadow-[0_0_5px_1px_rgba(255,255,255,0.20)]';
  }
}

function renderIcon(label, size, colorHex, options = {}) {
  const style = colorHex ? { color: colorHex } : undefined;
  const marginClass = options.collapsed ? '' : 'mr-2';
  const dim = Math.max(14, size - 2); // slightly smaller icons for a tighter rail
  switch (label) {
    case 'Pulse':         return <HeartPulse size={dim} className={`${marginClass} transition-colors`} style={style} />;
    case 'Bizzi':         return <Brain size={dim} className={`${marginClass} transition-colors`} style={style} />;
    case 'Email':         return <Mail size={dim} className={`${marginClass} transition-colors`} style={style} />;
    case 'Scheduling':    return <CalendarIcon size={dim} className={`${marginClass} transition-colors`} style={style} />;
    case 'Financials':    return <DollarSign size={dim} className={`${marginClass} transition-colors`} style={style} />;
    case 'Growth':        return <Rocket size={dim} className={`${marginClass} transition-colors`} style={style} />;
    case 'Jobs':          return <Briefcase size={dim} className={`${marginClass} transition-colors`} style={style} />;
    case 'Tax':           return <Landmark size={dim} className={`${marginClass} transition-colors`} style={style} />;
    case 'Investments':   return <TrendingUp size={dim} className={`${marginClass} transition-colors`} style={style} />;
    case 'Activity':      return <ActivityIcon size={dim} className={`${marginClass} transition-colors`} style={style} />;
    case 'Bizzi Docs':    return <FileText size={dim} className={`${marginClass} transition-colors`} style={style} />;
    case 'Settings/Sync': return <Settings size={dim} className={`${marginClass} transition-colors`} style={style} />;
    case 'Meet Bizzi':    return <Brain size={dim} className={`${marginClass} transition-colors`} style={style} />;
    default:              return <Brain size={dim} className={`${marginClass} transition-colors`} style={style} />;
  }
}

/* -------- path helpers -------- */
function pathActive(tabPath, currentPath) {
  if (!tabPath || !currentPath) return false;
  const a = tabPath.replace(/\/+$/, '');
  const b = currentPath.replace(/\/+$/, '');
  return b === a || b.startsWith(a + '/');
}
const DOCS_PATH = '/dashboard/bizzy-docs';

/* ======================== Pure / Memoized ======================== */
const PureSidebar = React.memo(function PureSidebar({
  className = '',
  compact = false,
  collapsed = false,
  activePath,
  unreadByModule = {},
  markModuleAsRead,
}) {
  const navigate = useNavigate();
  const [hoveredTab, setHoveredTab] = useState(null);
  const [tooltip, setTooltip] = useState({ label: null, x: 0, y: 0 });

  const SUPPRESS_BADGE_LABELS = useMemo(
    () => new Set(['Bizzi Docs','Meet Bizzi','Settings/Sync']),
    []
  );

  // ⬇️ Navigate ONLY. Do not clear here; badges clear when leaving via the effect below.
  const onNavigate = useCallback((path) => {
    // From ChatHome, clicking Pulse should go to the Pulse dashboard, not stay on chat
    if (path === '/dashboard/bizzy' && activePath.startsWith('/dashboard/bizzy/chat')) {
      navigate('/dashboard/bizzy');
      return;
    }
    // From any dashboard view, clicking the active icon should bounce back to ChatHome
    if (activePath.startsWith('/dashboard/') && !activePath.startsWith('/dashboard/bizzy/chat') && pathActive(path, activePath)) {
      navigate('/dashboard/bizzy/chat');
      return;
    }
    navigate(path);
  }, [navigate, activePath]);

  const sz = useMemo(() => ({
    outerPad:  compact ? 'p-3' : 'pl-3 pr-2',
    groupGap:  compact ? 'space-y-2' : 'space-y-3',
    itemPx:    compact ? 'px-2.5' : 'px-3',
    itemPy:    compact ? 'py-1.25' : 'py-1.25',
    itemText:  compact ? 'text-sm' : 'text-sm',
    groupMb:   compact ? 'mb-2' : 'mb-3',
    subMl:     compact ? 'ml-4' : 'ml-6',
    subText:   compact ? 'text-xs' : 'text-sm',
    icon:      compact ? 16 : 18,
    chevron:   compact ? 14 : 16,
  }), [compact]);

  const isModuleActive = useCallback((tab) => {
    const p = activePath;
    // Do not highlight Pulse when sitting on ChatHome
    if (tab.label === 'Pulse' && p.startsWith('/dashboard/bizzy/chat')) return false;
    if (tab.label === 'Leads & Jobs') return /\/(leads|jobs)\b/i.test(p);
    if (tab.label === 'Bizzi Docs Library') return p === DOCS_PATH || p.startsWith(DOCS_PATH + '/');
    return pathActive(tab.path, p);
  }, [activePath]);

  const navSpacing = collapsed ? 'pl-2 pr-1 space-y-2' : `${sz.outerPad} ${sz.groupGap}`;

  return (
    <nav
      data-sidebar
      className={`w-full ${navSpacing} ${className} text-secondary`}
      aria-label="Primary navigation"
    >
      {tabs.map((tab) => {
        const moduleKey = moduleKeyFromLabel(tab.label);
        const accentHex = accentHexMap[moduleKey] || accentHexMap.bizzy;

        const subItems = subSidebarConfig[tab.label.toLowerCase()];
        const isActive = isModuleActive(tab);
        const isHovered = hoveredTab === tab.label;
        const shouldShowDropdown = !collapsed && subItems && (isHovered || isActive);
        const hoverTooltip = tab.tooltip || tab.label;
        const disableNavigate = !!tab.disableNavigate;

        const isChromeTab = CHROME_TABS.has(tab.label);
        const iconColor = isChromeTab
          ? ((isActive || isHovered) ? CHROME_HEX : 'var(--text-2)')
          : ((isActive || isHovered) ? accentHex : 'var(--text-2)');

        const unreadCount = unreadByModule[moduleKey] || 0;
        const showBadge = unreadCount > 0 && !SUPPRESS_BADGE_LABELS.has(tab.label);

        const baseBtn = `w-full text-left flex items-center justify-between ${sz.itemPx} ${sz.itemPy}
                         rounded-lg transition ${sz.itemText}`;

        const classNameForButton = isChromeTab
          ? `${baseBtn} ${isActive ? 'bg-black' : 'hover:bg-[#202123]'}`
          : `${baseBtn} ${isActive ? renderActiveClass(tab.label) : `text-secondary hover:bg-[#202123] ${getHoverClass(tab.label)}`}`;

        const styleForButton = isChromeTab
          ? { boxShadow: (isActive || isHovered) ? `0 0 8px ${CHROME_SOFT}` : 'none', color: 'var(--text)' }
          : undefined;

        const showColoredBadge = !isChromeTab && (isActive || isHovered);
        const badgeStyle = showColoredBadge ? coloredBadgeStyle(accentHex) : neutralBadgeStyle;

          const containerClass = collapsed ? 'mb-1.5 flex justify-start pl-0.5' : sz.groupMb;
          const collapsedBtnClass =
          "group relative flex items-center justify-center h-[32px] w-[32px] rounded-xl transition text-secondary";

        return (
          <div
            key={tab.path}
            className={containerClass}
            onMouseEnter={(e) => {
              setHoveredTab(tab.label);
              if (collapsed) {
                const btn = e.currentTarget.querySelector('button');
                const icon = btn?.querySelector('svg');
                const targetRect =
                  icon?.getBoundingClientRect() ||
                  btn?.getBoundingClientRect() ||
                  e.currentTarget.getBoundingClientRect();
                const yCenter = targetRect.top + targetRect.height / 2;
                setTooltip({
                  label: hoverTooltip,
                  x: targetRect.right + 10,
                  y: yCenter - 13,
                });
              }
            }}
            onMouseLeave={() => {
              setHoveredTab(null);
              setTooltip({ label: null, x: 0, y: 0 });
            }}
          >
            <button
              onClick={(event) => {
                if (disableNavigate) {
                  event.preventDefault();
                  event.stopPropagation();
                  return;
                }
                onNavigate(tab.path, moduleKey);
              }}
              className={[
                collapsed ? collapsedBtnClass : classNameForButton,
                disableNavigate ? 'cursor-not-allowed focus:outline-none' : '',
              ].join(' ')}
              style={
                collapsed
                  ? {
                      color: 'var(--text)',
                      background: isActive
                        ? 'rgba(255,255,255,0.12)'
                        : (isHovered ? 'rgba(255,255,255,0.08)' : 'transparent'),
                      border: 'none',
                      boxShadow: 'none',
                      transition: 'background 150ms ease',
                    }
                  : {
                      ...(styleForButton || {}),
                      background: isActive
                        ? (isChromeTab ? 'rgba(32,33,35,1)' : styleForButton?.background || 'rgba(32,33,35,1)')
                        : (isHovered ? 'rgba(32,33,35,0.6)' : (styleForButton?.background || 'transparent')),
                      transition: 'background 150ms ease',
                    }
              }
              title={tab.tooltip || (collapsed ? tab.label : undefined)}
              aria-label={
                collapsed
                  ? tab.tooltip
                    ? `${tab.label} – ${tab.tooltip}`
                    : tab.label
                  : undefined
              }
              aria-disabled={disableNavigate ? 'true' : undefined}
            >
              <span className={`flex items-center min-w-0 ${collapsed ? 'justify-center' : 'whitespace-nowrap overflow-hidden text-ellipsis pr-2'}`}>
                {renderIcon(tab.label, collapsed ? 18 : sz.icon, iconColor, { collapsed })}
                {!collapsed && (
                  <>
                    <span className="truncate">{tab.label}</span>

                    {showBadge && (
                      <span
                        aria-label={`${unreadCount} unread insights`}
                        title={`${unreadCount} unread insights`}
                        className="ml-2 inline-flex items-center justify-center rounded-full text-[10px] px-[6px] py-[1px] leading-none"
                        style={badgeStyle}
                      >
                        {unreadCount > 9 ? '9+' : unreadCount}
                      </span>
                    )}
                  </>
                )}
              </span>

              {!collapsed && (
                <ChevronRight
                  className="flex-shrink-0"
                  size={sz.chevron}
                  style={isChromeTab && (isActive || isHovered) ? { color: CHROME_HEX } : undefined}
                />
              )}
            </button>

            <AnimatePresence initial={false}>
              {shouldShowDropdown && (
                <motion.div
                  key={`${tab.path}-dropdown`}
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.25 }}
                  className={`${sz.subMl} mt-1 space-y-1 overflow-hidden`}
                >
                  {subItems.map((item, i) => (
                    <NavLink
                      key={`${tab.path}|${item.path}|${i}`}
                      to={item.path}
                      className={({ isActive }) =>
                        `block ${sz.subText} px-2 py-1 rounded-md transition-colors ${
                          isActive
                            ? 'text-primary font-semibold'
                            : 'text-secondary hover:text-primary hover:bg-[rgba(255,255,255,0.08)]'
                        }`
                      }
                      // ⛔️ DO NOT clear on subnav click; clear happens on LEAVE via effect.
                      onClick={() => {}}
                    >
                      {item.label}
                    </NavLink>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}
      {collapsed && tooltip.label &&
        createPortal(
          <AnimatePresence>
            <motion.div
              initial={{ opacity: 0, x: -6, scale: 0.95 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: -4, scale: 0.95 }}
              transition={{ duration: 0.18 }}
              className="pointer-events-none fixed z-[9999] px-3 py-1 rounded-lg text-[12px] text-white bg-[rgba(28,28,30,0.92)] shadow-[0_10px_30px_rgba(0,0,0,0.35)]"
              style={{ top: tooltip.y, left: tooltip.x, transform: 'translateY(-50%)' }}
            >
              {tooltip.label}
            </motion.div>
          </AnimatePresence>,
          document.body
        )
      }
    </nav>
  );
}, areEqual);

/** Only change when what matters changes */
function areEqual(prev, next) {
  const prevSig = Object.entries(prev.unreadByModule || {})
    .sort(([a],[b]) => a.localeCompare(b))
    .map(([k,v]) => `${k}:${v}`)
    .join('|');

  const nextSig = Object.entries(next.unreadByModule || {})
    .sort(([a],[b]) => a.localeCompare(b))
    .map(([k,v]) => `${k}:${v}`)
    .join('|');

  return (
    prev.className === next.className &&
    prev.compact === next.compact &&
    prev.collapsed === next.collapsed &&
    prev.activePath === next.activePath &&
    prevSig === nextSig
  );
}

/* ======================== Container (hooks) ======================== */
export default function SidebarContainer(props) {
  const location = useLocation();
  const { unreadByModule: rawUnread = {}, markModuleAsRead } = useInsightsUnread?.() || {};

  const unreadByModule = useMemo(() => normalizeUnreadMap(rawUnread), [rawUnread]);
  const activePath = location.pathname;

  // Track previous module; clear when LEAVING it. Do not clear on /chat.
  const prevModuleRef = React.useRef(null);
  const currentModule = moduleKeyFromPath(activePath);

  useEffect(() => {
    if (typeof markModuleAsRead !== "function") return;

    const isChatHome =
      activePath.startsWith("/dashboard/bizzy/chat") ||
      activePath === "/chat" ||
      activePath.startsWith("/chat/");
    const prev = prevModuleRef.current;

    // Clear previous module when leaving it
    if (prev && prev !== currentModule && !isChatHome) {
      markModuleAsRead(prev);
      const alias =
        prev === "email"     ? "inbox" :
        prev === "calendar"  ? "sch"   :
        prev === "ops"       ? "jobs"  : null;
      if (alias) markModuleAsRead(alias);
    }

    // Update previous pointer (null for /chat so we never clear Pulse on entering ChatHome)
    prevModuleRef.current = isChatHome ? null : currentModule;
  }, [activePath, currentModule, markModuleAsRead]);

  return (
    <PureSidebar
      {...props}
      activePath={activePath}
      unreadByModule={unreadByModule}
      markModuleAsRead={markModuleAsRead}
    />
  );
}

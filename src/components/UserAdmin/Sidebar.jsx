import React, { useCallback, useMemo, useState, useEffect } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import {
  Brain, DollarSign, Rocket, FileText, TrendingUp,
  Calendar as CalendarIcon, Briefcase, BookOpen, Settings, Mail,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

import { subSidebarConfig } from '../../utils/subSidebarConfig';
import { useInsightsUnread } from '../../insights/InsightsUnreadContext';

/* ------------------------------ Tabs ------------------------------ */
const tabs = [
  { label: 'Pulse', path: '/dashboard/bizzy' },
  { label: 'Financials', path: '/dashboard/accounting' },
  { label: 'Marketing', path: '/dashboard/marketing' },
  { label: 'Jobs', path: '/dashboard/leads-jobs' },
  { label: 'Tax', path: '/dashboard/tax' },
  { label: 'Investments', path: '/dashboard/investments' },
  { label: 'Email', path: '/dashboard/email' },
  { label: 'Calendar', path: '/dashboard/calendar' },
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
  calendar:    '#94a3b8',
  ops:         '#94a3b8',
};

function moduleKeyFromLabel(label) {
  const k = label.toLowerCase();
  if (k === 'financials') return 'accounting';
  if (k === 'bizzi') return 'bizzy';
  if (k === 'marketing') return 'marketing';
  if (k === 'tax') return 'tax';
  if (k === 'investments') return 'investments';
  if (k === 'email') return 'email';
  if (k === 'bizzi docs') return 'docs';
  if (k === 'meet bizzi') return 'companion';
  if (k === 'settings/sync' || k === 'settings' || k === 'sync') return 'settings';
  if (k === 'calendar') return 'calendar';
  if (k === 'jobs') return 'ops';
  return 'bizzy';
}

/* -------- path -> module helpers -------- */
function moduleKeyFromPath(pathname = '') {
  const seg = (pathname.split('/')[2] || '').toLowerCase();
  if (seg === 'financials' || seg === 'accounting') return 'accounting';
  if (seg === 'marketing') return 'marketing';
  if (seg === 'tax') return 'tax';
  if (seg === 'investments') return 'investments';
  if (seg === 'email' || seg === 'inbox') return 'email';
  if (seg === 'calendar' || seg === 'sch') return 'calendar';
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

const CHROME_TABS = new Set(['Pulse', 'Jobs', 'Bizzi Docs', 'Meet Bizzi', 'Settings/Sync', 'Calendar']);
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
  switch (label) {
    case 'Financials':  return 'text-neon-green  shadow-[0_0_8px_1px_#00FFB2] font-semibold bg-black';
    case 'Marketing':   return 'text-neon-blue   shadow-[0_0_8px_1px_#3B82F6] font-semibold bg-black';
    case 'Tax':         return 'text-neon-gold   shadow-[0_0_8px_1px_#FFD700] font-semibold bg-black';
    case 'Investments': return 'text-neon-purple shadow-[0_0_8px_1px_#B388FF] font-semibold bg-black';
    case 'Email':       return 'text-white shadow-[0_0_8px_1px_#3CF2FF] font-semibold bg-black';
    default:            return 'text-white font-semibold bg-black';
  }
}
function getHoverClass(label) {
  switch (label) {
    case 'Financials':  return 'hover:shadow-[0_0_8px_1px_#00FFB2]';
    case 'Marketing':   return 'hover:shadow-[0_0_8px_1px_#3B82F6]';
    case 'Tax':         return 'hover:shadow-[0_0_8px_1px_#FFD700]';
    case 'Investments': return 'hover:shadow-[0_0_8px_1px_#B388FF]';
    case 'Email':       return 'hover:shadow-[0_0_8px_1px_#3CF2FF]';
    default:            return '';
  }
}

function renderIcon(label, size, colorHex) {
  const style = colorHex ? { color: colorHex } : undefined;
  switch (label) {
    case 'Bizzi':         return <Brain size={size} className="mr-2" style={style} />;
    case 'Email':         return <Mail size={size} className="mr-2" style={style} />;
    case 'Calendar':      return <CalendarIcon size={size} className="mr-2" style={style} />;
    case 'Financials':    return <DollarSign size={size} className="mr-2" style={style} />;
    case 'Marketing':     return <Rocket size={size} className="mr-2" style={style} />;
    case 'Jobs':          return <Briefcase size={size} className="mr-2" style={style} />;
    case 'Tax':           return <FileText size={size} className="mr-2" style={style} />;
    case 'Investments':   return <TrendingUp size={size} className="mr-2" style={style} />;
    case 'Bizzi Docs':    return <BookOpen size={size} className="mr-2" style={style} />;
    case 'Settings/Sync': return <Settings size={size} className="mr-2" style={style} />;
    case 'Meet Bizzi':    return <Brain size={size} className="mr-2" style={style} />;
    default:              return <Brain size={size} className="mr-2" style={style} />;
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
  activePath,
  unreadByModule = {},
  markModuleAsRead,
}) {
  const navigate = useNavigate();
  const [hoveredTab, setHoveredTab] = useState(null);

  const SUPPRESS_BADGE_LABELS = useMemo(
    () => new Set(['Bizzi Docs','Meet Bizzi','Settings/Sync']),
    []
  );

  // ⬇️ Navigate ONLY. Do not clear here; badges clear when leaving via the effect below.
  const onNavigate = useCallback((path /*, moduleKey */) => {
    navigate(path);
  }, [navigate]);

  const sz = useMemo(() => ({
    outerPad:  compact ? 'p-3' : 'p-4',
    groupGap:  compact ? 'space-y-2' : 'space-y-4',
    itemPx:    compact ? 'px-2' : 'px-4',
    itemPy:    compact ? 'py-1.5' : 'py-2',
    itemText:  compact ? 'text-sm' : 'text-base',
    groupMb:   compact ? 'mb-2' : 'mb-4',
    subMl:     compact ? 'ml-4' : 'ml-6',
    subText:   compact ? 'text-xs' : 'text-sm',
    icon:      compact ? 16 : 18,
    chevron:   compact ? 14 : 16,
  }), [compact]);

  const isModuleActive = useCallback((tab) => {
    const p = activePath;
    if (tab.label === 'Leads & Jobs') return /\/(leads|jobs)\b/i.test(p);
    if (tab.label === 'Bizzi Docs Library') return p === DOCS_PATH || p.startsWith(DOCS_PATH + '/');
    return pathActive(tab.path, p);
  }, [activePath]);

  return (
    <nav data-sidebar className={`w-full ${sz.outerPad} ${sz.groupGap} ${className} text-secondary`} aria-label="Primary navigation">
      {tabs.map((tab) => {
        const moduleKey = moduleKeyFromLabel(tab.label);
        const accentHex = accentHexMap[moduleKey] || accentHexMap.bizzy;

        const subItems = subSidebarConfig[tab.label.toLowerCase()];
        const isActive = isModuleActive(tab);
        const isHovered = hoveredTab === tab.label;
        const shouldShowDropdown = subItems && (isHovered || isActive);

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

        return (
          <div
            key={tab.path}
            className={sz.groupMb}
            onMouseEnter={() => setHoveredTab(tab.label)}
            onMouseLeave={() => setHoveredTab(null)}
          >
            <button
              onClick={() => onNavigate(tab.path, moduleKey)}
              className={classNameForButton}
              style={styleForButton}
            >
              <span className="flex items-center min-w-0 whitespace-nowrap overflow-hidden text-ellipsis pr-2">
                {renderIcon(tab.label, sz.icon, iconColor)}
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
              </span>

              <ChevronRight
                className="flex-shrink-0"
                size={sz.chevron}
                style={isChromeTab && (isActive || isHovered) ? { color: CHROME_HEX } : undefined}
              />
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
                        `block ${sz.subText} px-2 py-1 rounded-md ${
                          isActive ? 'text-primary font-semibold' : 'text-secondary hover:text-primary'
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

    const isChatHome = activePath === "/chat" || activePath.startsWith("/chat/");
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

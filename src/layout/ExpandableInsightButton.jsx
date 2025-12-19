import React, { useState, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import ExpandableInsightPanel from '../layout/ExpandableInsightPanel';
import useOutsideClick from '../hooks/useOutsideClick';
import { motion, AnimatePresence } from 'framer-motion';

const moduleConfig = {
  accounting: { icon: '💵', color: 'text-emerald-400' },
  marketing: { icon: '🚀', color: 'text-blue-400' },
  tax: { icon: '📄', color: 'text-yellow-400' },
  investments: { icon: '📈', color: 'text-purple-400' },
};

const ExpandableInsightButton = ({ variant = 'mobile' }) => {
  const [isOpen, setIsOpen] = useState(false);
  const location = useLocation();
  const ref = useRef(null);

  const path = location.pathname;
  const moduleKey =
    path.includes('accounting') ? 'accounting' :
    path.includes('marketing') ? 'marketing' :
    path.includes('tax') ? 'tax' :
    path.includes('investments') ? 'investments' :
    'accounting';

  const { icon, color } = moduleConfig[moduleKey];

  useOutsideClick(ref, () => setIsOpen(false));

  // Positioning for button
  const buttonClass =
    variant === 'mobile'
      ? `fixed bottom-[96px] right-4 z-50`
      : `relative z-10`; // inline in header

  // Positioning for the panel (still needs to be centralized)
  const panelPosition =
    variant === 'mobile'
      ? `fixed bottom-20 left-1/2 transform -translate-x-1/2 w-[90%] md:w-[420px]`
      : `absolute top-16 right-0 w-[420px]`; // adjust if needed

  return (
    <>
      {/* Floating Toggle Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`p-3 rounded-full bg-black/70  backdrop-blur-md hover:scale-105 transition-all duration-200 ${buttonClass} ${color}`}
      >
        <span className="text-lg">{icon}</span>
      </button>

      {/* Animated Panel */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            ref={ref}
            className={`${panelPosition} z-50 bg-zinc-900 text-white  border-white rounded-xl shadow-xl p-4`}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.2 }}
          >
            <ExpandableInsightPanel module={moduleKey} onClose={() => setIsOpen(false)} />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};


export default ExpandableInsightButton;

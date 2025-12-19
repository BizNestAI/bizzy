// File: /src/components/UserAdmin/BusinessSwitcher.jsx
import React, { useEffect, useState, useRef } from 'react';
import { ChevronDown } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase } from '../../services/supabaseClient';
import { useAuth } from '../../context/AuthContext';
import useModuleTheme from '../../hooks/useModuleTheme';
import useDemoMode from '../../hooks/useDemoMode';
import { getDemoBusinessName } from '../../services/demo/demoClient';

const BusinessSwitcher = ({ currentBusiness, setCurrentBusiness }) => {
  const { user } = useAuth();
  const [businesses, setBusinesses] = useState([]);
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef(null);
  const demoMode = useDemoMode();
  const usingDemo = demoMode === 'demo';
  const demoName = getDemoBusinessName() || "Mike's Remodeling";

  // Route-aware theme still loaded (we won't use textClass/borderClass/shadowClass for the quiet look)
  useModuleTheme();

  useEffect(() => {
    const fetchBusinesses = async () => {
      if (!user?.id) return;

      const { data, error } = await supabase
        .from('user_business_link')
        .select('business_profiles(id, business_name)')
        .eq('user_id', user.id)
        .order('created_at', { ascending: true });

      if (error) {
        console.error('Failed to fetch businesses:', error.message);
        return;
      }

      const fetched = (data || []).map((e) => e.business_profiles);
      setBusinesses(fetched);

      if (!currentBusiness && fetched.length === 1 && fetched[0]?.id) {
        setCurrentBusiness(fetched[0]);
        localStorage.setItem('currentBusinessId', fetched[0].id);
      }
    };

    fetchBusinesses();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const handleSelect = (business) => {
    if (!business?.id) return;
    setOpen(false);
    setCurrentBusiness(business);
    localStorage.setItem('currentBusinessId', business.id);
  };

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  // Use the neutral ChatHome chrome border everywhere
  const defaultBorder = 'var(--accent-line)';

  const buttonLabel = usingDemo ? demoName : (currentBusiness?.business_name || 'Select Business');

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => { if (!usingDemo) setOpen((prev) => !prev); }}
        aria-disabled={usingDemo}
        disabled={usingDemo}
        className="
          flex items-center gap-2 px-4 py-2 rounded-[10px]
          bg-[rgba(12,16,21,0.55)]
          text-[#e5e7eb] text-sm
          border
          transition
          hover:bg-[rgba(16,20,26,0.65)]
          focus:outline-none
        "
        style={{
          borderColor: defaultBorder,
          boxShadow: 'none',                // 🔕 no glow
          opacity: usingDemo ? 0.8 : 1,
        }}
      >
        <span className="truncate">{buttonLabel}</span>
        <ChevronDown className="w-4 h-4 opacity-80" />
      </button>

      <AnimatePresence>
        {open && !usingDemo && (
          <motion.ul
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.15 }}
            className="
              absolute right-0 mt-2 w-56 overflow-hidden z-50
              bg-[#0e1318] text-[#e5e7eb] rounded-md
              border
              shadow-[0_14px_28px_rgba(0,0,0,0.45)]
            "
            style={{ borderColor: defaultBorder }}
          >
            {businesses.map((b) => {
              const isActive = currentBusiness?.id === b.id;
              return (
                <li
                  key={b.id}
                  onClick={() => handleSelect(b)}
                  className={`
                    px-4 py-2 text-sm cursor-pointer transition
                    hover:bg-[rgba(255,255,255,0.06)]
                    ${isActive ? 'font-semibold' : ''}
                  `}
                >
                  {b.business_name}
                </li>
              );
            })}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
};

export default BusinessSwitcher;

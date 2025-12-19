// /src/components/UserAdmin/SubSidebar.jsx
import React, { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { subSidebarConfig } from '../../utils/subSidebarConfig';
import { Menu, X } from 'lucide-react';

const getModuleFromPath = (pathname) => {
  const match = pathname.split('/')[2];
  return ['accounting', 'marketing', 'tax', 'investments'].includes(match) ? match : null;
};

const SubSidebar = () => {
  const location = useLocation();
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const moduleKey = getModuleFromPath(location.pathname);

  if (!moduleKey) return null;

  const tabs = subSidebarConfig[moduleKey];

  return (
    <>
      {/* Desktop SubSidebar */}
      <aside className="hidden md:flex flex-col w-48 bg-black border-r border-gray-800 text-white px-4 py-6 space-y-2">
        {tabs.map((tab) => (
          <NavLink
            key={tab.path}
            to={tab.path}
            className={({ isActive }) =>
              `block px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                isActive ? 'bg-gray-800 text-neon-green' : 'hover:bg-[rgba(255,255,255,0.08)] hover:text-white'
              }`
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </aside>

      {/* Mobile Drawer */}
      <div className="md:hidden px-4 py-2">
        <button onClick={() => setIsMobileOpen((prev) => !prev)}>
          {isMobileOpen ? <X size={24} /> : <Menu size={24} />}
        </button>

        {isMobileOpen && (
          <div className="absolute top-14 left-0 w-48 h-full bg-black z-50 border-r border-gray-800 p-4 space-y-2">
            {tabs.map((tab) => (
              <NavLink
                key={tab.path}
                to={tab.path}
                onClick={() => setIsMobileOpen(false)}
                className={({ isActive }) =>
                  `block px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                    isActive ? 'bg-gray-800 text-neon-green' : 'hover:bg-[rgba(255,255,255,0.08)] hover:text-white'
                  }`
                }
              >
                {tab.label}
              </NavLink>
            ))}
          </div>
        )}
      </div>
    </>
  );
};

export default SubSidebar;

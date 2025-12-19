import React, { useEffect, useState, useRef } from 'react';
import { Bell } from 'lucide-react';
import { fetchNotifications, markNotificationAsRead } from '../../services/notificationService';
import { useAuth } from '../../context/AuthContext';
import { useBusiness } from '../../context/BusinessContext';
import { supabase } from '../../services/supabaseClient';
import useModuleTheme from '../../hooks/useModuleTheme';
import { motion, AnimatePresence } from 'framer-motion';

export default function NotificationsDropdown() {
  const { user } = useAuth();
  const { currentBusiness } = useBusiness();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const { textClass, borderClass, shadowClass } = useModuleTheme();
  const dropdownRef = useRef(null);

  useEffect(() => {
    if (!user?.id || !currentBusiness?.id) return;

    const loadNotifications = async () => {
      const { data } = await fetchNotifications(user.id, currentBusiness.id);
      setNotifications(data || []);
      setUnreadCount((data || []).filter((n) => !n.read).length);
    };

    loadNotifications();

    const subscription = supabase
      .channel('notifications-realtime')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${user.id}`,
        },
        (payload) => {
          const newNotification = payload.new;
          if (newNotification.business_id === currentBusiness.id) {
            setNotifications((prev) => [newNotification, ...prev]);
            setUnreadCount((prev) => prev + 1);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(subscription);
    };
  }, [user, currentBusiness]);

  const handleMarkAsRead = async (id) => {
    await markNotificationAsRead(id);
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n))
    );
    setUnreadCount((prev) => Math.max(prev - 1, 0));
  };

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [open]);

  return (
    <div className="relative" ref={dropdownRef}>
      <button onClick={() => setOpen(!open)} className="relative">
        <Bell className={`${textClass}`} />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 bg-red-600 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">
            {unreadCount}
          </span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
            className={`absolute right-0 mt-2 w-80 bg-white dark:bg-black shadow-lg ${borderClass} ${shadowClass} rounded z-50`}
          >
            <div className={`p-3 font-bold border-b dark:border-gray-700 ${textClass}`}>
              Notifications
            </div>

            {notifications.length === 0 ? (
              <div className="p-4 text-sm text-gray-500">No notifications yet.</div>
            ) : (
              <ul className="max-h-64 overflow-y-auto">
                {notifications.map((note) => (
                  <li
                    key={note.id}
                    className={`p-3 text-sm border-b dark:border-gray-700 ${
                      note.read ? 'text-gray-500' : `${textClass} font-semibold`
                    }`}
                  >
                    <div className="flex justify-between items-start gap-3">
                      <div className="flex items-start gap-2">
                        <span className="text-xl">{getIconForType(note.type)}</span>
                        <span>{note.message}</span>
                      </div>
                      {!note.read && (
                        <button
                          onClick={() => handleMarkAsRead(note.id)}
                          className={`${textClass} text-xs hover:underline`}
                        >
                          Mark as read
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const getIconForType = (type) => {
  switch (type) {
    case 'insight':
      return '🧠';
    case 'tax':
      return '📅';
    case 'financial':
      return '💵';
    case 'marketing':
      return '📣';
    case 'recap':
      return '📈';
    default:
      return '🔔';
  }
};

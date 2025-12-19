// File: src/App.jsx

import React, { useEffect, useState } from 'react';
import MainLayout from './layout/MainLayout';
import { useAuth } from './context/AuthContext';
import { logout } from './services/authService';
import { useNavigate } from 'react-router-dom';
import { supabase } from './services/supabase';

export default function App() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [business, setBusiness] = useState(null);
  const [loading, setLoading] = useState(true);

  const handleLogout = async () => {
    await logout();
    localStorage.removeItem('isProfileComplete');
    navigate('/login');
  };

  useEffect(() => {
    const fetchBusinessProfile = async () => {
      const { data, error } = await supabase
        .from('business_profiles')
        .select('*')
        .eq('user_id', user.id)
        .single();

      if (error || !data) {
        localStorage.setItem('isProfileComplete', 'false');
        navigate('/setup');
      } else {
        localStorage.setItem('isProfileComplete', 'true');
        setBusiness(data);
      }

      setLoading(false);
    };

    if (user) {
      fetchBusinessProfile();
    }
  }, [user, navigate]);

  if (loading) return <div className="p-6 text-emerald-400">Loading your business dashboard...</div>;

  return (
    <MainLayout>
      <div className="text-2xl font-bold p-6 text-emerald-500">
        Welcome to Bizzi – your AI business brain.
      </div>

      {/* ✅ Tailwind CSS Test Box */}
      <div className="bg-emerald-100 border-l-4 border-emerald-500 text-emerald-800 p-4 mb-4 mx-6 rounded">
        ✅ Tailwind CSS is working correctly!
      </div>

      <div className="px-6 pb-6 gray-600 space-y-1">
        <p>
          Logged in as: <span className="font-medium">{user?.email}</span>
        </p>
        <p>
          Business: <span className="font-semibold">{business?.business_name}</span>
        </p>
        <p>Industry: {business?.industry}</p>
        <p>State: {business?.state}</p>
        <p>Team Size: {business?.team_size}</p>
      </div>


      <div className="px-6">
        <button
          onClick={handleLogout}
          className="bg-neonPink text-white px-4 py-2 rounded hover:bg-neonPink"
        >
          Logout
        </button>
      </div>
    </MainLayout>
  );
}

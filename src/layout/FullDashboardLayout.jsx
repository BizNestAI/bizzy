// src/layout/FullDashboardLayout.jsx
import React from 'react';
import { Outlet } from 'react-router-dom';
import MainLayout from './MainLayout';
import DashboardLayout from './DashboardLayout';

const FullDashboardLayout = () => {
  return (
    <MainLayout>
      <DashboardLayout>
        <Outlet />   {/* ← this is the page content area */}
      </DashboardLayout>
    </MainLayout>
  );
};

export default FullDashboardLayout;

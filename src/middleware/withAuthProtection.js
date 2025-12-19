// File: /src/middleware/withAuthProtection.js
import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

const withAuthProtection = (Component) => {
  return (props) => {
    const { user, loading } = useAuth();

    if (loading) return <div className="text-white p-4">Loading...</div>;
    if (!user) return <Navigate to="/login" replace />;
    
    return <Component {...props} />;
  };
};

export default withAuthProtection;

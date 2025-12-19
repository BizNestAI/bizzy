// File: src/components/DevTools/NeonThemePreview.jsx
import React from 'react';

const themes = [
  { name: 'Pink', color: 'neon-pink' },
  { name: 'Green', color: 'neon-green' },
  { name: 'Blue', color: 'neon-blue' },
  { name: 'Gold', color: 'neon-gold' },
  { name: 'Purple', color: 'neon-purple' },
];

const NeonThemePreview = () => {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6 p-6 bg-black rounded-xl border border-white">
      {themes.map(({ name, color }) => (
        <div
          key={color}
          className={`p-6 rounded-xl bg-black text-${color} border border-${color} shadow-${color} transition-all duration-300`}
        >
          <h2 className={`text-xl font-bold mb-2`}>{name}</h2>
          <p className="text-sm opacity-80">text-{color}</p>
          <p className="text-sm opacity-80">border-{color}</p>
          <p className="text-sm opacity-80">shadow-{color}</p>
        </div>
      ))}
    </div>
  );
};

export default NeonThemePreview;

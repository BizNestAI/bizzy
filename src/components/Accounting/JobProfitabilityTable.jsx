// File: /components/Accounting/JobProfitabilityTable.jsx

import React, { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Info, Search } from 'lucide-react';
import { motion } from 'framer-motion';
import { getJobProfitabilityData } from '../../services/accounting/getJobProfitabilityData';


const getMarginColor = (margin) => {
  if (margin >= 40) return 'text-green-400';
  if (margin >= 20) return 'text-yellow-400';
  return 'text-red-400';
};

export default function JobProfitabilityTable({ userId, businessId }) {
  const [viewMode, setViewMode] = useState('job');
  const [sortKey, setSortKey] = useState('revenue');
  const [sortAsc, setSortAsc] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [data, setData] = useState([]);

  useEffect(() => {
  const fetchData = async () => {
    try {
      const allData = await getJobProfitabilityData(userId, businessId);
      const filtered = allData?.filter((item) => item.type === viewMode) || [];
      setData(filtered);
    } catch (err) {
      console.error('Failed to fetch job data:', err);
    }
  };

  if (userId && businessId) fetchData();
}, [viewMode, userId, businessId]);



  const sorted = [...data].sort((a, b) => {
    const valA = a[sortKey];
    const valB = b[sortKey];
    return sortAsc ? valA - valB : valB - valA;
  }).filter((row) => row.name.toLowerCase().includes(searchQuery.toLowerCase()));

  const headers = [
    { key: 'name', label: 'Client / Job Name' },
    { key: 'revenue', label: 'Revenue ($)' },
    { key: 'costs', label: 'Direct Costs ($)' },
    { key: 'grossProfit', label: 'Gross Profit ($)' },
    { key: 'marginPct', label: 'Gross Margin (%)' }
  ];

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="bg-zinc-900 border border-zinc-700 rounded-xl p-4 space-y-4"
    >
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
        <h2 className="text-lg font-semibold text-white">📐 Job Costing & Profitability</h2>
        <div className="flex gap-2">
          <button
            onClick={() => setViewMode('job')}
            className={`px-3 py-1 rounded-md border text-sm ${viewMode === 'job' ? 'bg-neon-green text-black' : 'bg-zinc-800 text-white border-zinc-600'}`}
          >Job View</button>
          <button
            onClick={() => setViewMode('client')}
            className={`px-3 py-1 rounded-md border text-sm ${viewMode === 'client' ? 'bg-neon-green text-black' : 'bg-zinc-800 text-white border-zinc-600'}`}
          >Client View</button>
        </div>
      </div>

      <div className="flex justify-between items-center">
        <div className="relative w-64">
          <Search className="absolute left-2 top-2.5 text-gray-400 w-4 h-4" />
          <input
            type="text"
            placeholder="Search by name"
            className="w-full pl-8 py-2 bg-zinc-800 text-white border border-zinc-700 rounded-md"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm text-white">
          <thead className="border-b border-zinc-700">
            <tr>
              {headers.map(({ key, label }) => (
                <th
                  key={key}
                  onClick={() => {
                    setSortKey(key);
                    setSortAsc((prev) => (key === sortKey ? !prev : false));
                  }}
                  className="text-left px-4 py-2 cursor-pointer"
                >
                  {label}{' '}
                  {sortKey === key && (sortAsc ? <ArrowUp className="inline w-4 h-4" /> : <ArrowDown className="inline w-4 h-4" />)}
                </th>
              ))}
              <th className="text-left px-4 py-2">View</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((item, idx) => (
              <tr key={idx} className="border-b border-zinc-800">
                <td className="px-4 py-2 font-medium text-white">{item.name}</td>
                <td className="px-4 py-2">${item.revenue.toLocaleString()}</td>
                <td className="px-4 py-2">${item.costs.toLocaleString()}</td>
                <td className="px-4 py-2">${item.grossProfit.toLocaleString()}</td>
                <td className={`px-4 py-2 font-semibold ${getMarginColor(item.marginPct)}`}>{item.marginPct.toFixed(1)}%</td>
                <td className="px-4 py-2">
                  <button className="text-sm text-neon-green hover:underline">View</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </motion.div>
  );
}

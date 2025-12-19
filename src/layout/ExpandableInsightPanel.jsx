import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { X } from 'lucide-react';
import FinancialKPICards from '../components/Accounting/FinancialKPICards';
import RevenueChart from '../components/Accounting/RevenueChart';
import NetProfitChart from '../components/Accounting/NetProfitChart';
import ExpenseBreakdownChart from '../components/Accounting/ExpenseBreakdownChart';

const moduleInsights = {
  accounting: {
    title: '💵 Financial Insights',
    description: 'Here’s a snapshot of your recent financial performance.',
    highlights: [
      { label: 'Revenue (MTD)', value: '$42,000' },
      { label: 'Net Profit', value: '$12,400' },
      { label: 'Profit Margin', value: '29.5%' },
    ],
    themeColor: 'text-emerald-400',
  },
  marketing: {
    title: '🚀 Marketing Insights',
    description: 'Quick glance at your marketing performance.',
    highlights: [
      { label: 'Reach This Week', value: '21,000' },
      { label: 'Top Post', value: '"Before & After Kitchen Remodel"' },
      { label: 'CTR', value: '6.8%' },
    ],
    themeColor: 'text-blue-400',
  },
  tax: {
    title: '📄 Tax Snapshot',
    description: 'High-level view of upcoming tax items.',
    highlights: [
      { label: 'Estimated Tax Due', value: '$3,150' },
      { label: 'Next Filing', value: 'Sep 15, 2025' },
      { label: 'Quarterly Status', value: '✅ On Track' },
    ],
    themeColor: 'text-yellow-400',
  },
  investments: {
    title: '📈 Investment Pulse',
    description: 'How your business assets are trending.',
    highlights: [
      { label: 'Portfolio Value', value: '$184,500' },
      { label: '1-Mo ROI', value: '+4.3%' },
      { label: 'Top Performer', value: 'S&P 500 ETF' },
    ],
    themeColor: 'text-purple-400',
  },
};

const ExpandableInsightPanel = ({ module, onClose }) => {
  const content = moduleInsights[module] || moduleInsights.accounting;
  const [tab, setTab] = useState('kpis');

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      transition={{ duration: 0.2 }}
      className="relative w-full"
    >
      {/* Close Button */}
      <button
        onClick={onClose}
        className="absolute top-2 right-2 text-white/80 hover:text-white transition"
      >
        <X size={20} />
      </button>

      {/* Title + Description */}
      <h2 className={`text-xl font-semibold mb-1 ${content.themeColor}`}>
        {content.title}
      </h2>
      <p className="text-sm text-white/70 mb-4">{content.description}</p>

      {/* Tabs: Mobile Only */}
      <div className="md:hidden mb-4 flex justify-between items-center border-b border-white/10">
        {['kpis', 'charts', 'alerts'].map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 py-2 text-sm font-semibold transition border-b-2 ${
              tab === t
                ? 'border-neon-green text-neon-green'
                : 'border-transparent text-white/50 hover:text-white'
            }`}
          >
            {t === 'kpis' && '🧮 KPIs'}
            {t === 'charts' && '📊 Charts'}
            {t === 'alerts' && '🚨 Alerts'}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="md:hidden">
        {tab === 'kpis' && module === 'accounting' && <FinancialKPICards />}
        {tab === 'charts' && module === 'accounting' && (
          <div className="flex flex-col gap-4">
            <RevenueChart />
            <NetProfitChart />
            <ExpenseBreakdownChart />
          </div>
        )}
        {tab === 'alerts' && (
          <div className="text-white/70 text-sm">
            🚨 No alerts this month. Keep up the great work!
          </div>
        )}
      </div>

      {/* Desktop: Static Highlights Only */}
      {module === 'accounting' && (
        <div className="hidden md:block">
          <ul className="space-y-3 mt-4">
            {content.highlights.map((item, index) => (
              <li
                key={index}
                className="flex justify-between bg-white/5 px-3 py-2 rounded-md border border-white/10"
              >
                <span className="text-white/80 text-sm">{item.label}</span>
                <span className="text-white font-medium">{item.value}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </motion.div>
  );
};

export default ExpandableInsightPanel;

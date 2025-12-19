// File: /src/pages/LeadsJobs/LeadsJobs.jsx
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Calendar as CalendarIcon, Plus, Upload, Filter, ChevronRight } from 'lucide-react';

import { useRightExtras } from '../../insights/RightExtrasContext.jsx';
import AgendaWidget from '../calendar/AgendaWidget.jsx';

// ⬇️ NEW: bring in your existing profitability table
import JobProfitabilityTable from '../../components/Accounting/JobProfitabilityTable.jsx';

const ACCENT = '#FF4EEB'; // Use bizzy pink for now; you can theme "ops" later

export default function LeadsJobs() {
  const navigate = useNavigate();
  const { setRightExtras } = useRightExtras();
  const businessId = localStorage.getItem('currentBusinessId') || '';
  const userId = localStorage.getItem('user_id') || '';

  // Publish a small agenda widget to the right rail
  useEffect(() => {
    setRightExtras(
      <AgendaWidget
        businessId={businessId}
        module="ops"
        onOpenCalendar={() => navigate('/dashboard/calendar')}
      />
    );
    return () => setRightExtras(null);
  }, [businessId, navigate, setRightExtras]);

  // --- Mock metrics & kanban data (placeholder) ---
  const [filtersOpen] = useState(false);
  const metrics = useMemo(() => ([
    { label: 'New Leads (7d)', value: 18 },
    { label: 'Jobs Scheduled', value: 12 },
    { label: 'Win Rate (30d)', value: '27%' },
  ]), []);

  const pipeline = useMemo(() => ([
    { id: 'new',        title: 'New Lead',    items: mockItems(3, 'New') },
    { id: 'qualified',  title: 'Qualified',   items: mockItems(4, 'Qualified') },
    { id: 'scheduled',  title: 'Scheduled',   items: mockItems(3, 'Scheduled') },
    { id: 'inprogress', title: 'In Progress', items: mockItems(2, 'In Progress') },
    { id: 'won',        title: 'Won',         items: mockItems(2, 'Won') },
    { id: 'lost',       title: 'Lost',        items: mockItems(1, 'Lost') },
  ]), []);

  // --- Styles ---
  const cardGlow = { boxShadow: `0 0 16px ${ACCENT}33` };
  const tile = 'rounded-xl border border-white/10 bg-[#0B0E13]/70 backdrop-blur';
  const pillBtn =
    'inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/15 ' +
    'text-sm text-white/80 hover:text-white hover:border-white/30 transition';

  return (
    <div className="flex flex-col min-h-full px-4 pt-4">
      {/* Header */}
      <header className={`${tile} px-4 py-3 mb-4`} style={cardGlow}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-xl md:text-2xl font-bold text-white">Job Flow</h1>
            <p className="text-white/60 text-sm">
              Manage your pipeline from new leads to completed jobs. Drag-drop coming soon.
            </p>
          </div>
          <div className="flex items-center flex-wrap gap-2">
            <button
              className={pillBtn}
              title="Quick schedule"
              onClick={() => navigate('/dashboard/calendar')}
            >
              <CalendarIcon size={16} />
              Open Calendar
            </button>
            <button className={pillBtn} title="Import CSV (coming soon)" disabled>
              <Upload size={16} />
              Import CSV
            </button>
            <button className={pillBtn} title="Add lead (coming soon)" disabled>
              <Plus size={16} />
              New Lead
            </button>
          </div>
        </div>
      </header>

      {/* Top metrics */}
      <section className="mb-4 grid gap-3 grid-cols-1 md:grid-cols-3">
        {metrics.map((m) => (
          <div key={m.label} className={`${tile} p-4`} style={cardGlow}>
            <div className="text-white/60 text-sm">{m.label}</div>
            <div className="text-2xl font-semibold text-white mt-1">{m.value}</div>
          </div>
        ))}
      </section>

      {/* Pipeline + Activity */}
      <main className="grid gap-4 grid-cols-1 xl:grid-cols-3">
        {/* Left: Kanban + Profitability (2/3) */}
        <section className="xl:col-span-2 space-y-4">
          <div className={`${tile} p-3`} style={cardGlow}>
            {/* Filters row (placeholder) */}
            <div className="flex items-center justify-between px-2 py-2">
              <div className="text-white/80 font-semibold">Pipeline</div>
              <button className={pillBtn} title="Filters (coming soon)" disabled={!filtersOpen}>
                <Filter size={14} />
                Filters
              </button>
            </div>

            {/* Kanban: Columns */}
            <div className="mt-2 grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3 2xl:grid-cols-6">
              {pipeline.map((col) => (
                <KanbanColumn key={col.id} title={col.title} items={col.items} />
              ))}
            </div>
          </div>

          {/* NEW: Job Profitability table moved here from Bizzy dashboard */}
          <div className={`${tile} p-4`} style={cardGlow}>
            <div className="text-white/85 font-semibold mb-3">Job Profitability</div>
            <JobProfitabilityTable userId={userId} />
          </div>
        </section>

        {/* Right: Schedule & Recent activity (1/3) */}
        <aside className="space-y-4">
          <div className={`${tile} p-4`} style={cardGlow}>
            <div className="text-white/85 font-semibold mb-2">Upcoming</div>
            <ul className="space-y-2 text-sm">
              {/* Placeholder items */}
              <li className="flex items-center justify-between text-white/80">
                <span>8:00 AM — Site walk / Johnson</span>
                <ChevronRight size={14} className="text-white/40" />
              </li>
              <li className="flex items-center justify-between text-white/80">
                <span>1:30 PM — Roof repair / Acme</span>
                <ChevronRight size={14} className="text-white/40" />
              </li>
              <li className="flex items-center justify-between text-white/80">
                <span>3:15 PM — Estimate review</span>
                <ChevronRight size={14} className="text-white/40" />
              </li>
            </ul>
          </div>

          <div className={`${tile} p-4`} style={cardGlow}>
            <div className="text-white/85 font-semibold mb-2">Recent updates</div>
            <ul className="space-y-2 text-sm">
              <li className="text-white/70">New lead from form — “Williams Siding”</li>
              <li className="text-white/70">Job scheduled — “Kitchen remodel” (Fri 9:30 AM)</li>
              <li className="text-white/70">Status updated — “Repair — In Progress”</li>
            </ul>
          </div>
        </aside>
      </main>
    </div>
  );
}

/* ------------------------------
 * Column + Card placeholders
 * ------------------------------ */

function KanbanColumn({ title, items }) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/50">
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
        <span className="text-white/85 text-sm font-semibold">{title}</span>
        <span className="text-white/50 text-xs">{items.length}</span>
      </div>
      <div className="p-2 space-y-2">
        {items.map((item) => (
          <div
            key={item.id}
            className="rounded-md border border-white/10 bg-[#0B0E13]/70 px-3 py-2 text-sm text-white/80"
          >
            <div className="flex items-center justify-between">
              <span className="font-medium truncate">{item.title}</span>
              <span className="text-white/50 text-xs">{item.when}</span>
            </div>
            <div className="text-white/60 text-xs mt-0.5">
              {item.customer} • {item.city}
            </div>
            {/* Tags */}
            <div className="mt-2 flex flex-wrap gap-1">
              {item.tags.map((t) => (
                <span
                  key={t}
                  className="px-2 py-0.5 rounded-full text-[11px] border border-white/10 text-white/70 bg-white/[0.03]"
                >
                  {t}
                </span>
              ))}
            </div>
          </div>
        ))}

        {items.length === 0 && (
          <div className="text-white/50 text-xs p-2">No items yet.</div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------
 * Utilities
 * ------------------------------ */

function mockItems(n = 2, label = 'Item') {
  const cities = ['Charlotte, NC', 'Matthews, NC', 'Huntersville, NC', 'Concord, NC'];
  const tags = [
    ['roofing', 'estimate'],
    ['remodel', 'site-walk'],
    ['service', 'urgent'],
    ['repair', 'materials'],
  ];
  return Array.from({ length: n }).map((_, i) => ({
    id: `${label}-${i}`,
    title: `${label} #${i + 1}`,
    customer: ['Acme Co', 'Johnson LLC', 'Williams Homes'][i % 3],
    city: cities[i % cities.length],
    when: ['Today', 'Tomorrow', 'Fri'][i % 3],
    tags: tags[i % tags.length],
  }));
}

// File: /src/components/Accounting/BookkeepingFilters.jsx
import React, { memo } from "react";

function BookkeepingFilters({ filters, setFilters, accountFilterOptions, pageSize, setPageSize }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 text-sm text-white/80">
      <div className="inline-flex items-center gap-1.5">
        <span className="text-white/60 text-xs">Date</span>
        <select
          value={filters.range}
          onChange={(e) => setFilters((f) => ({ ...f, range: e.target.value }))}
          className="rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 text-sm text-white focus:outline-none"
        >
          <option value="recent">This month</option>
          <option value="prior">Last month</option>
          <option value="all">All recent</option>
        </select>
      </div>
      <div className="inline-flex items-center gap-1.5">
        <span className="text-white/60 text-xs">Account</span>
        <select
          value={filters.account}
          onChange={(e) => setFilters((f) => ({ ...f, account: e.target.value }))}
          className="rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 text-sm text-white focus:outline-none"
        >
          {accountFilterOptions.map((opt) => (
            <option key={opt} value={opt}>{opt === "all" ? "All bank/CC" : opt}</option>
          ))}
        </select>
      </div>
      <div className="inline-flex items-center gap-1.5">
        <span className="text-white/60 text-xs">Rows</span>
        <select
          value={pageSize}
          onChange={(e) => setPageSize(Number(e.target.value))}
          className="rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 text-sm text-white focus:outline-none"
        >
          {[10, 25, 50].map((n) => (
            <option key={n} value={n}>{n} per page</option>
          ))}
        </select>
      </div>
    </div>
  );
}

export default memo(BookkeepingFilters);

// File: /src/components/Accounting/BookkeepingCleanupHeader.jsx
import React, { memo } from "react";
import { Zap } from "lucide-react";

function BookkeepingCleanupHeader() {
  return (
    <header className="rounded-2xl border border-white/5 bg-[#0d1a15] px-4 py-4 shadow-[0_10px_28px_rgba(0,0,0,0.2)]">
      <div className="flex flex-col gap-1.5 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-2">
          <p className="uppercase tracking-[0.35em] text-[11px] text-white/60">Financials</p>
          <h1 className="text-[20px] sm:text-[22px] font-semibold tracking-[0.2em] text-white leading-tight">Books Review</h1>
          <p className="mt-2 max-w-2xl text-[13px] text-white/70 leading-relaxed">
            Bizzi helps clean your uncategorized transactions so your insights are accurate.
          </p>
        </div>
        <div className="inline-flex items-center gap-2 rounded-lg border border-white/5 bg-white/5 px-3 py-1.5 text-xs text-white/70">
          <Zap size={14} className="text-emerald-300" />
          Coaching mode on — ask Bizzi about any transaction.
        </div>
      </div>
    </header>
  );
}

export default memo(BookkeepingCleanupHeader);

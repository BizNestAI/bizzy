// /src/components/Tax/TaxMonthlySnapshot.jsx
// Deprecated Prompt 29 compatibility shell.
// Canonical Tax history is represented by immutable tax calculation runs.
import React from "react";
import { Archive } from "lucide-react";
import CardHeader from "../UI/CardHeader";

export default function TaxMonthlySnapshot({ onOpenDeductions }) {
  return (
    <div className="w-full min-w-0">
      <CardHeader
        title="MONTHLY TAX SNAPSHOT"
        size="sm"
        dense
        className="mb-2"
        titleClassName="text-[13px]"
      />
      <div className="rounded-xl p-4 bg-white/5 ring-1 ring-inset ring-white/10 text-white">
        <div className="flex items-start gap-3">
          <Archive className="mt-0.5 h-4 w-4 text-white/60" aria-hidden="true" />
          <div>
            <div className="text-sm font-semibold">Legacy snapshot retired</div>
            <p className="mt-1 text-sm text-white/70">
              Tax estimates now come from canonical calculation runs. Use Tax Overview,
              Deductions, Planning, and Explanation panels for current tax details.
            </p>
            {onOpenDeductions ? (
              <button
                type="button"
                onClick={onOpenDeductions}
                className="mt-3 rounded-full border border-white/12 px-3 py-1.5 text-xs text-white/80 hover:bg-white/10"
              >
                Open deductions workspace
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

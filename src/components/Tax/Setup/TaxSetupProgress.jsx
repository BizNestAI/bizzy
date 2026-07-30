import React from "react";
import { CheckCircle2 } from "lucide-react";
import { TAX_SETUP_STEP_IDS, TAX_SETUP_STEPS, stepIndex } from "./taxSetupSteps.js";

export default function TaxSetupProgress({ currentStepId, onSelect }) {
  const current = stepIndex(currentStepId);
  return (
    <nav aria-label="Tax setup progress" className="border-b border-white/10 px-4 py-3 sm:px-5">
      <ol className="flex gap-2 overflow-x-auto pb-1">
        {TAX_SETUP_STEPS.map((step, index) => {
          const complete = index < current;
          const active = step.id === currentStepId;
          return (
            <li key={step.id} className="shrink-0">
              <button
                type="button"
                onClick={() => onSelect?.(step.id)}
                className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold transition focus:outline-none focus:ring-2 focus:ring-emerald-300/40 ${
                  active
                    ? "border-emerald-300/45 bg-emerald-300/12 text-emerald-50"
                    : "border-white/10 bg-white/[0.04] text-white/62 hover:bg-white/[0.08] hover:text-white"
                }`}
                aria-current={active ? "step" : undefined}
              >
                {complete ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-200" /> : <span>{index + 1}</span>}
                {step.title}
              </button>
            </li>
          );
        })}
      </ol>
      <div className="mt-2 text-xs text-white/48">
        Step {current + 1} of {TAX_SETUP_STEP_IDS.length}
      </div>
    </nav>
  );
}

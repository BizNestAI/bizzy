import React from "react";

/**
 * Small corner ribbon to indicate mock/sample data.
 * Place inside a relatively positioned card.
 */
export default function SampleDataRibbon({ text = "Sample data" }) {
  return (
    <div className="absolute top-0 right-0 translate-x-2 -translate-y-2">
      <div className="bg-gradient-to-r from-blue-500 to-cyan-400 text-white text-[10px] font-semibold px-2 py-1 rounded-md shadow
                      ring-1 ring-white/20">
        {text}
      </div>
    </div>
  );
}

// src/components/email/SearchBar.jsx
import React, { useState, useEffect, useMemo } from "react";
import { Search, X } from "lucide-react";

/**
 * Props:
 * - value
 * - onChange(value)
 * - onSubmit(value)
 */
export default function SearchBar({ value = "", onChange, onSubmit }) {
  const [local, setLocal] = useState(value);

  useEffect(() => setLocal(value), [value]);

  // tiny debounce so typing feels smoother
  const debounced = useMemo(() => {
    let t;
    return (v) => {
      clearTimeout(t);
      t = setTimeout(() => onChange?.(v), 250);
    };
  }, [onChange]);

  const submit = (e) => {
    e?.preventDefault();
    onSubmit?.(local);
  };

  const clear = () => {
    setLocal("");
    onChange?.("");
    onSubmit?.("");
  };

  return (
    <form onSubmit={submit} className="mb-3 px-2 pt-2">
      <div className="flex items-center gap-2 bg-zinc-950/80 border border-zinc-800/80 rounded-lg px-2 py-1.5 shadow-[0_0_0_1px_rgba(0,0,0,0.2)]">
        <Search size={16} className="text-zinc-500 shrink-0" />
        <input
          value={local}
          onChange={(e) => {
            setLocal(e.target.value);
            debounced(e.target.value);
          }}
          placeholder="Search email"
          className="flex-1 bg-transparent text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none"
        />
        {local && (
          <button
            type="button"
            onClick={clear}
            className="p-1 rounded hover:bg-zinc-800 text-zinc-400"
            aria-label="Clear"
          >
            <X size={14} />
          </button>
        )}
      </div>
    </form>
  );
}

import React from "react";

export default function SettingsTabs({ items = [], activeTab, onSelect, softBorder }) {
  return items.map(({ key, icon: Icon }) => {
    const active = activeTab === key;
    return React.createElement(
      "button",
      {
        key,
        type: "button",
        onClick: () => onSelect?.(key),
        "aria-selected": active,
        className: "group inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[13px] focus:outline-none focus-visible:outline-none focus:ring-0 focus-visible:ring-0 active:outline-none active:ring-0",
        style: active
          ? {
              outline: "none",
              transition: "none",
              color: "var(--text)",
              border: "1px solid rgba(var(--accent-rgb),0.24)",
              boxShadow: "none",
              background: "rgba(var(--accent-rgb),0.1)",
            }
          : {
              outline: "none",
              transition: "none",
              color: "var(--text)",
              border: `1px solid ${softBorder}`,
              background: "rgba(255,255,255,0.018)",
            },
      },
      Icon
        ? React.createElement(Icon, {
            className: "h-4 w-4 opacity-75 group-hover:opacity-100",
            "aria-hidden": "true",
          })
        : null,
      key
    );
  });
}

import React from "react";
import { Activity as ActivityIcon, Clock3, Bell } from "lucide-react";

const PREVIEW_CARDS = [
  {
    title: "Live Biz Ops",
    copy: "Track installs, dispatches, and crew check-ins without leaving Bizzi. Every update rolls into one clean stream.",
    icon: Clock3,
  },
  {
    title: "Smart Alerts",
    copy: "Bizzi will bubble up anything that needs your attention—missed emails, overdue invoices, or hot leads.",
    icon: Bell,
  },
];

export default function ActivityHub() {
  return (
    <div className="p-6 text-secondary">
      <section className="max-w-3xl mx-auto text-center bg-[rgba(32,33,35,0.85)] border border-white/10 rounded-3xl px-8 py-10 shadow-[0_20px_60px_rgba(0,0,0,0.45)]">
        <div className="inline-flex items-center justify-center h-16 w-16 rounded-2xl bg-white/5 border border-white/10 shadow-inner shadow-black/30 text-zinc-200 mb-6">
          <ActivityIcon size={28} />
        </div>
        <p className="text-xs uppercase tracking-[0.3em] text-zinc-400">Activity</p>
        <h1 className="mt-3 text-3xl font-semibold text-white">Activity feed is coming soon</h1>
        <p className="mt-4 text-base text-zinc-300 leading-relaxed">
          We&apos;re building a chrome-silver command center that unifies job progress, customer pings, and money-in motion.
          The tab is here so you can find it the moment it launches.
        </p>
        <div className="mt-6 inline-flex items-center gap-2 px-4 py-2 rounded-full border border-white/15 text-sm text-white/90">
          <Bell size={16} className="text-amber-300" />
          Coming Soon!
        </div>
      </section>

      <section className="mt-10 grid grid-cols-1 md:grid-cols-2 gap-4">
        {PREVIEW_CARDS.map(({ title, copy, icon: Icon }) => (
          <div
            key={title}
            className="rounded-2xl bg-[rgba(24,24,27,0.85)] border border-white/10 p-5 flex gap-4"
          >
            <div className="h-11 w-11 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-zinc-200">
              <Icon size={22} />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-white">{title}</h3>
              <p className="text-sm text-zinc-400 mt-1 leading-relaxed">{copy}</p>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

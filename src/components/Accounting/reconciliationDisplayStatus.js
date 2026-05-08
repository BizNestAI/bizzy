export function getReconciliationDisplayStatus(status, opts = {}) {
  const rawStatus = String(status || "unknown").toLowerCase();
  const hasRows = opts.hasRows !== false;
  const hasData = opts.hasData !== false;
  const needsSetup = opts.needsSetup === true;

  if (rawStatus === "failed" && needsSetup) {
    return { label: "Needs setup", tone: "amber" };
  }
  if (rawStatus === "failed" && !hasRows) {
    return { label: "Monitoring unavailable", tone: "rose" };
  }
  if (rawStatus === "investigating") {
    return { label: "Needs attention", tone: "amber" };
  }
  if (rawStatus === "ok") {
    return { label: "Healthy", tone: "green" };
  }
  if (rawStatus === "partial") {
    return { label: "Partially monitored", tone: "blue" };
  }
  if (rawStatus === "unknown" && !hasData) {
    return { label: "Not ready", tone: "slate" };
  }
  if (rawStatus === "failed") {
    return { label: "Monitoring unavailable", tone: "rose" };
  }
  return { label: "Not ready", tone: "slate" };
}

export function getReconciliationDisplayClass(tone) {
  switch (tone) {
    case "green":
      return "bg-emerald-500/15 text-emerald-200 border-emerald-400/40";
    case "amber":
      return "bg-amber-400/15 text-amber-100 border-amber-300/40";
    case "blue":
      return "bg-cyan-500/12 text-cyan-100 border-cyan-400/30";
    case "rose":
      return "bg-rose-500/12 text-rose-100 border-rose-400/35";
    default:
      return "bg-slate-500/15 text-slate-200 border-slate-400/30";
  }
}

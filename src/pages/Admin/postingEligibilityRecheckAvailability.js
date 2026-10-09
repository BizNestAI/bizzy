export function derivePostingEligibilityRecheckAvailability({
  handledTotalCount,
  countLoaded,
  loading = false,
  executing = false,
  authorized = false,
  contextReady = false,
} = {}) {
  const handledCount = Number(handledTotalCount || 0);
  const isLoading = loading || !countLoaded;
  if (!authorized) return { disabled: true, title: "You do not have permission to perform this action." };
  if (!contextReady) return { disabled: true, title: "Select a valid business and review month." };
  if (executing) return { disabled: true, title: "A posting-eligibility recheck is already running." };
  if (isLoading) return { disabled: true, title: "Loading Handled transactions…" };
  if (handledCount === 0) return { disabled: true, title: "No Handled transactions exist for the selected month." };
  return { disabled: false, title: "Preview a server-side posting eligibility recheck." };
}

export default derivePostingEligibilityRecheckAvailability;

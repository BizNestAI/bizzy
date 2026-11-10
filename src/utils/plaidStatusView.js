// Presentation of authenticated, normalized status evidence only; no provider I/O.
const ACTIONS = new Set(['reconnect_securely', 'reconnect_bank_securely', 'review_account_identity', 'confirm_new_item', 'review_account_mapping', 'review_bank_connection', 'review_possible_gap', 'contact_support', 'resume_reconnect']);
const ATTENTION = new Set(['attention_required', 'reauthentication_required', 'identity_review_required', 'new_item_identity_required', 'new_item_confirmation_required', 'lineage_confirmation_required', 'awaiting_account_selection', 'gap_review_required', 'blocked', 'internal_failure', 'failed']);
const RECOVERING = new Set(['reconnect_in_progress', 'waiting_for_replay', 'replaying', 'processing', 'updating', 'recovering', 'preview_building', 'importing']);
const RETRYING = new Set(['temporarily_unavailable', 'institution_unavailable', 'delayed', 'retrying']);
export const STATUS_LABELS = Object.freeze({ healthy: 'Sync active', attention: 'Needs attention', recovering: 'Recovering', retrying: 'Sync temporarily unavailable', disconnected: 'Disconnected', unknown: 'Status unavailable' });
export function plaidStatusView(entity = {}, recovery = entity.recovery) {
  const s = entity.recovery_status;
  const bank = s?.bank_connection;
  const imported = s?.transaction_import;
  const states = [bank?.state, imported?.state, entity.sync_health?.status, recovery?.orchestration?.status];
  const action = bank?.recommended_action || entity.sync_health?.recommended_action;
  const batch = recovery?.batch;
  let state = 'unknown';
  if (entity.connection_state === 'closed_historical' || entity.connection_state === 'disconnected' || bank?.state === 'disconnected' || entity.status === 'disconnected') state = 'disconnected';
  else if (entity.sync_health?.automatic_retry_scheduled === true && !ACTIONS.has(action) && !bank?.recommended_action?.startsWith('review_') && !states.some(x => ['reauthentication_required', 'identity_review_required', 'new_item_identity_required', 'new_item_confirmation_required', 'blocked'].includes(x))) state = 'retrying';
  else if (states.some(x => ATTENTION.has(x)) || ACTIONS.has(action) || ['failed', 'blocked', 'imported_held'].includes(batch?.status) || (recovery?.recovery_required === true && !states.some(x => RECOVERING.has(x)))) state = 'attention';
  else if (states.some(x => RECOVERING.has(x)) || ['preview_ready', 'confirmed'].includes(batch?.status)) state = 'recovering';
  else if (states.some(x => RETRYING.has(x))) state = 'retrying';
  else if (imported?.state === 'current' || entity.sync_health?.status === 'active') state = 'healthy';
  else if (entity.connection_state === 'attention_required' || entity.status === 'attention_required') state = 'attention';
  return { state, label: state === 'attention' && (states.includes('reauthentication_required') || ['reconnect_securely', 'reconnect_bank_securely'].includes(action)) ? 'Reconnect required' : STATUS_LABELS[state], compact: state === 'healthy', reconnect: states.includes('reauthentication_required') || ['reconnect_securely', 'reconnect_bank_securely'].includes(action), resume: states.includes('reconnect_in_progress') || action === 'resume_reconnect' };
}
export function institutionView(institution, recovery = institution.recovery) {
  const own = plaidStatusView(institution, recovery);
  const accounts = (institution.accounts || []).map(a => plaidStatusView(a));
  const mappingMissing = (institution.accounts || []).some(a => a.recovery_status?.quickbooks_posting?.blockers?.mapping_missing === true);
  const priority = ['attention', 'recovering', 'retrying', 'healthy', 'disconnected', 'unknown'];
  const state = mappingMissing ? 'attention' : priority.find(s => own.state === s || accounts.some(a => a.state === s)) || 'unknown';
  const nextAction = mappingMissing ? 'Select the appropriate QuickBooks account below.'
    : state === 'attention' && !own.reconnect && !own.resume ? 'Review the account or recovery details below. Contact your operator if identity or import review is required.'
      : state === 'recovering' ? 'Recovery is in progress. Keep this connection while verification completes.' : null;
  return { ...own, state, label: state === own.state ? own.label : STATUS_LABELS[state], compact: state === 'healthy', nextAction };
}
export function integrationSummary(institutions = [], { loading = false, error = false, recoveryByItem = {}, totals } = {}) {
  if (loading) return 'Loading bank status…';
  if (error) return 'Bank status unavailable';
  const groups = new Map();
  for (const inst of institutions) {
    const key = inst.institution_id || inst.plaid_item_id;
    if (!key) return Number.isInteger(totals?.institutions) && Number.isInteger(totals?.accounts)
      ? `${totals.institutions} institution${totals.institutions === 1 ? '' : 's'} · ${totals.accounts} account${totals.accounts === 1 ? '' : 's'} · status unavailable` : 'Bank status unavailable';
    const list = groups.get(key) || []; list.push(institutionView(inst, recoveryByItem[inst.plaid_item_id] || inst.recovery)); groups.set(key, list);
  }
  const counts = {};
  for (const list of groups.values()) {
    const state = ['attention', 'recovering', 'retrying', 'healthy', 'disconnected', 'unknown'].find(s => list.some(v => v.state === s));
    counts[state] = (counts[state] || 0) + 1;
  }
  const labels = { healthy: 'syncing', attention: 'needs attention', recovering: 'recovering', retrying: 'temporarily unavailable', disconnected: 'disconnected', unknown: 'unavailable' };
  return ['healthy', 'recovering', 'retrying', 'attention', 'disconnected', 'unknown'].filter(k => counts[k]).map(k => `${counts[k]} ${k === 'attention' && counts[k] !== 1 ? 'need attention' : labels[k]}`).join(' · ') || 'No banks connected';
}
export function postingHoldMessage(entity = {}, recovery = entity.recovery) {
  const p = entity.recovery_status?.quickbooks_posting;
  const accountCounts = entity.accounts?.map(a => a.recovery_status?.quickbooks_posting?.held_count).filter(Number.isFinite);
  const count = p?.held_count ?? (accountCounts?.length ? accountCounts.reduce((sum, n) => sum + n, 0) : undefined);
  if (Number.isFinite(count) && count > 0) return `${count} recovered transaction${count === 1 ? ' is' : 's are'} held from QuickBooks posting pending review.`;
  if (recovery?.batch?.posting_hold === true) return 'Recovered transactions are held from QuickBooks posting pending review.';
  if (p?.state === 'reconciling') return 'QuickBooks posting requires receipt reconciliation.';
  return null;
}
export function postingLabel(account = {}, policy) {
  const held = postingHoldMessage(account); if (held) return held;
  const p = account.recovery_status?.quickbooks_posting;
  if (p?.blockers?.auto_post_disabled === true || policy?.auto_post_to_quickbooks === false) return 'QuickBooks auto-post is off.';
  if (p && p.state !== 'active' && p.reason_code !== 'auto_post_disabled') return p.customer_copy || 'QuickBooks posting needs review.';
  if (policy?.auto_post_to_quickbooks === true) {
    const date = policy.auto_post_effective_date || (policy.auto_post_scope_mode === 'new_activity_only' ? policy.auto_post_enabled_at : null);
    return date ? `QuickBooks auto-post starts ${String(date).slice(0, 10)}.` : 'Posting start date is not configured.';
  }
  return 'QuickBooks posting status unavailable.';
}
export function accountConnectionLabel(account, institution) {
  const bank = account.recovery_status?.bank_connection;
  if (bank?.reason_code === 'account_identity_review_required') return 'Identity review required';
  if (bank?.reason_code === 'account_connection_attention_required') return 'Account connection needs review';
  if (account.recovery_status?.transaction_import?.state === 'gap_review_required') return 'Account coverage needs review';
  if (account.connection_state === 'attention_required') return institutionView(institution).state === 'attention' ? null : 'Account needs attention';
  return ({ connected: 'Connected', disconnected: 'Disconnected', closed_historical: 'Closed · history retained' })[account.connection_state] || null;
}

// File: /src/api/gpt/utils/intentToModule.js
// Maps an intent key to a high-level module for thread labeling.
// Keep in sync with your registry groupings.

const EMAIL = new Set(['email_summarize','email_reply','email_template',
  'email_search','email_extract_tasks','email_followup','email_find_contact']);

const FIN = new Set([
  'fin_variance_explain','forecast_generate','cash_runway','invoice_status',
  'expense_spike','job_profitability','pricing_strategy','fin_overview'
]);
const TAX = new Set([
  'tax_liability_estimate','tax_deadlines','tax_deductions_find','tax_move_explain','tax_overview'
]);
const MKT = new Set(['content_generate','reviews_insights','review_request_flow','mkt_overview']);
const INV = new Set(['retirement_projection','contribution_limit','rebalance_advice','inv_overview']);
const OPS = new Set(['job_status','lead_followup','agenda_range','calendar_schedule']);

export function intentToModule(intent) {
  if (!intent) return 'bizzy';
  if (EMAIL.has(intent)) return 'email';
  if (FIN.has(intent)) return 'financials';
  if (TAX.has(intent)) return 'tax';
  if (MKT.has(intent)) return 'marketing';
  if (INV.has(intent)) return 'investments';
  if (OPS.has(intent)) return 'calendar';
  return 'bizzy';
}
export default intentToModule;

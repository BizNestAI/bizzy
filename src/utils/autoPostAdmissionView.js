export const ADMISSION_REFRESH_LIMIT = 6;
export const admissionRefreshDelay = attempt => Math.min(30000,2500 * 2 ** Math.min(attempt,4));
export function shouldRefreshAdmission(status) {
  return status?.auto_post_to_quickbooks === true && status?.worker?.enabled !== false &&
    ["pending","retry"].includes(status?.admission?.state || status?.state);
}
export function admissionNotice(status) {
  const state=status?.admission?.state || status?.state;
  if(state==="retry")return "Scheduling needs retry";
  if(state==="pending" && status?.auto_post_to_quickbooks===true)return "Scheduling pending";
  if(state==="terminal")return status?.error==="stale_or_changed_admission_preview" ? "Scheduling preview changed or expired. Preview again before confirming." : "Scheduling needs review";
  return null;
}

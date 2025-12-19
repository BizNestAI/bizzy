export const toTitleCasePlatform = (p='') =>
  p ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : '';

export function toUtcIsoFromLocal(localDateTime) {
  // local "YYYY-MM-DDTHH:mm" -> UTC ISO
  const d = new Date(localDateTime);
  if (isNaN(d.getTime())) return null;
  return new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString();
}

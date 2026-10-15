export const REPORTING_TIMEZONE_OPTIONS = Object.freeze([
  { value: "America/New_York", label: "Eastern Time" },
  { value: "America/Chicago", label: "Central Time" },
  { value: "America/Denver", label: "Mountain Time" },
  { value: "America/Los_Angeles", label: "Pacific Time" },
  { value: "America/Phoenix", label: "Arizona Time" },
  { value: "America/Anchorage", label: "Alaska Time" },
  { value: "Pacific/Honolulu", label: "Hawaii Time" },
  { value: "UTC", label: "UTC" },
]);

const STATE_NAMES = Object.freeze({
  AL: "Alabama", AR: "Arkansas", AZ: "Arizona", CA: "California", CO: "Colorado",
  CT: "Connecticut", DC: "District of Columbia", DE: "Delaware", GA: "Georgia",
  HI: "Hawaii", IA: "Iowa", IL: "Illinois", LA: "Louisiana", MA: "Massachusetts",
  MD: "Maryland", ME: "Maine", MN: "Minnesota", MO: "Missouri", MS: "Mississippi",
  MT: "Montana", NC: "North Carolina", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NV: "Nevada", NY: "New York", OH: "Ohio", OK: "Oklahoma",
  PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", UT: "Utah",
  VA: "Virginia", VT: "Vermont", WA: "Washington", WI: "Wisconsin",
  WV: "West Virginia", WY: "Wyoming",
});

// Deliberately excludes every state with meaningful multi-timezone or boundary ambiguity.
const UNAMBIGUOUS_STATE_TIMEZONES = Object.freeze({
  AL: "America/Chicago", AR: "America/Chicago", AZ: "America/Phoenix",
  CA: "America/Los_Angeles", CO: "America/Denver", CT: "America/New_York",
  DC: "America/New_York", DE: "America/New_York", GA: "America/New_York",
  HI: "Pacific/Honolulu", IA: "America/Chicago", IL: "America/Chicago",
  LA: "America/Chicago", MA: "America/New_York", MD: "America/New_York",
  ME: "America/New_York", MN: "America/Chicago", MO: "America/Chicago",
  MS: "America/Chicago", MT: "America/Denver", NC: "America/New_York",
  NH: "America/New_York", NJ: "America/New_York", NM: "America/Denver",
  NV: "America/Los_Angeles", NY: "America/New_York", OH: "America/New_York",
  OK: "America/Chicago", PA: "America/New_York", RI: "America/New_York",
  SC: "America/New_York", UT: "America/Denver", VA: "America/New_York",
  VT: "America/New_York", WA: "America/Los_Angeles", WI: "America/Chicago",
  WV: "America/New_York", WY: "America/Denver",
});

const NAME_TO_CODE = Object.freeze(Object.fromEntries(
  Object.entries(STATE_NAMES).map(([code, name]) => [name.toLowerCase(), code])
));

export function normalizeBusinessState(state) {
  const value = String(state || "").trim();
  if (!value) return null;
  const code = value.toUpperCase();
  if (STATE_NAMES[code]) return code;
  return NAME_TO_CODE[value.toLowerCase()] || null;
}

export function getSuggestedReportingTimezone(state) {
  const code = normalizeBusinessState(state);
  return code ? UNAMBIGUOUS_STATE_TIMEZONES[code] || null : null;
}

export function getBusinessStateName(state) {
  const code = normalizeBusinessState(state);
  return code ? STATE_NAMES[code] || null : null;
}

export function getReportingTimezoneOption(value) {
  return REPORTING_TIMEZONE_OPTIONS.find((option) => option.value === value) || null;
}


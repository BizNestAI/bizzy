export const TAX_PROFILE_SOURCE_LABELS = {
  user: "Confirmed by you",
  cpa: "Provided by CPA",
  imported: "Imported",
  inferred: "Inferred by Bizzi",
  system: "Suggested from business profile",
  missing: "Missing",
};

export const US_STATE_OPTIONS = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI",
  "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN",
  "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH",
  "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA",
  "WV", "WI", "WY",
].map((code) => ({ value: code, label: code }));

export const ENTITY_OPTIONS = [
  { value: "sole_proprietor", label: "Sole proprietor", description: "Business profit generally flows to your personal return and may be subject to self-employment tax." },
  { value: "single_member_llc", label: "Single-member LLC", description: "Bizzi needs the LLC tax election before routing the estimate." },
  { value: "s_corp", label: "S-Corporation", description: "Bizzi separates owner wages from pass-through business income." },
  { value: "unknown", label: "I'm not sure", description: "Check your prior return, formation records, or tax professional before relying on the estimate." },
  { value: "unsupported", label: "Other / unsupported", description: "Bizzi may not support this entity path yet." },
];

export const LLC_ELECTION_OPTIONS = [
  { value: "disregarded_entity", label: "Disregarded entity / Schedule C" },
  { value: "s_corp", label: "S-Corporation election" },
  { value: "unknown", label: "I'm not sure" },
];

export const FILING_STATUS_OPTIONS = [
  { value: "single", label: "Single" },
  { value: "married_filing_jointly", label: "Married filing jointly" },
  { value: "married_filing_separately", label: "Married filing separately" },
  { value: "head_of_household", label: "Head of household" },
  { value: "qualifying_surviving_spouse", label: "Qualifying surviving spouse" },
  { value: "unknown", label: "I'm not sure" },
];

export const ACCOUNTING_METHOD_OPTIONS = [
  { value: "cash", label: "Cash" },
  { value: "accrual", label: "Accrual" },
  { value: "other", label: "I'm not sure" },
];

export const SAFE_HARBOR_OPTIONS = [
  { value: "current_year_90", label: "Current-year estimate" },
  { value: "prior_year_100", label: "Prior-year 100%" },
  { value: "prior_year_110", label: "Prior-year 110%" },
  { value: "custom", label: "Custom" },
  { value: "unknown", label: "I'm not sure" },
];

export const TRI_STATE_OPTIONS = [
  { value: true, label: "Yes" },
  { value: false, label: "No" },
  { value: null, label: "I'm not sure" },
];

export const TAX_PROFILE_FIELDS = {
  entity_type: {
    key: "entity_type",
    label: "Business tax structure",
    type: "choice",
    options: ENTITY_OPTIONS,
    requiredWhen: () => true,
    allowUnknown: true,
  },
  tax_election: {
    key: "tax_election",
    label: "LLC tax election",
    type: "choice",
    options: LLC_ELECTION_OPTIONS,
    requiredWhen: (values) => values.entity_type === "single_member_llc",
    applicableEntityPaths: ["single_member_llc"],
    allowUnknown: true,
  },
  filing_status: {
    key: "filing_status",
    label: "Filing status",
    type: "choice",
    options: FILING_STATUS_OPTIONS,
    requiredWhen: () => true,
    allowUnknown: true,
  },
  primary_tax_state: {
    key: "primary_tax_state",
    label: "Primary tax state",
    type: "state",
    options: US_STATE_OPTIONS,
    requiredWhen: () => true,
    helpText: "Suggested states must be confirmed before they count as user-provided setup.",
  },
  accounting_method: {
    key: "accounting_method",
    label: "Accounting method",
    type: "choice",
    options: ACCOUNTING_METHOD_OPTIONS,
    requiredWhen: () => true,
    allowUnknown: true,
  },
  qbi_eligible: {
    key: "qbi_eligible",
    label: "Could this business be eligible for the qualified business income deduction?",
    description: "Bizzi is collecting this information, but the current estimate does not yet include a calculated QBI deduction.",
    type: "boolean_unknown",
    options: TRI_STATE_OPTIONS,
    recommendedWhen: () => true,
    allowUnknown: true,
  },
  self_employment_tax_applies: {
    key: "self_employment_tax_applies",
    label: "Does self-employment tax generally apply?",
    type: "boolean_unknown",
    options: TRI_STATE_OPTIONS,
    requiredWhen: (values) => isSoleOrDisregarded(values),
    applicableEntityPaths: ["sole_proprietor", "single_member_llc"],
    allowUnknown: true,
  },
  safe_harbor_method: {
    key: "safe_harbor_method",
    label: "Safe-harbor planning method",
    type: "choice",
    options: SAFE_HARBOR_OPTIONS,
    requiredWhen: () => true,
    allowUnknown: true,
  },
  prior_year_total_tax: {
    key: "prior_year_total_tax",
    label: "Prior-year total tax",
    type: "money",
    requiredWhen: (values) => ["prior_year_100", "prior_year_110"].includes(values.safe_harbor_method),
  },
  prior_year_agi: {
    key: "prior_year_agi",
    label: "Prior-year AGI",
    type: "money",
    requiredWhen: (values) => values.safe_harbor_method === "prior_year_110",
    recommendedWhen: (values) => values.safe_harbor_method === "prior_year_100",
  },
  owner_reasonable_salary: {
    key: "owner_reasonable_salary",
    label: "Reasonable salary target",
    type: "money",
    requiredWhen: (values) => isSCorp(values),
    applicableEntityPaths: ["s_corp", "single_member_llc"],
  },
  owner_w2_wages_ytd: {
    key: "owner_w2_wages_ytd",
    label: "Owner W-2 wages YTD",
    type: "money",
    requiredWhen: (values) => isSCorp(values),
  },
  federal_withholding_ytd: { key: "federal_withholding_ytd", label: "Federal withholding YTD", type: "money", recommendedWhen: () => true },
  state_withholding_ytd: { key: "state_withholding_ytd", label: "State withholding YTD", type: "money", recommendedWhen: () => true },
  health_insurance_deduction_ytd: { key: "health_insurance_deduction_ytd", label: "Health-insurance deduction YTD", type: "money", recommendedWhen: () => true },
  retirement_contributions_ytd: { key: "retirement_contributions_ytd", label: "Retirement contributions YTD", type: "money", recommendedWhen: () => true },
  hsa_contributions_ytd: { key: "hsa_contributions_ytd", label: "HSA contributions YTD", type: "money", recommendedWhen: () => true },
  reserve_buffer_percent: {
    key: "reserve_buffer_percent",
    label: "Reserve buffer percent",
    type: "percent",
    recommendedWhen: () => true,
  },
};

export const MONEY_FIELDS = Object.values(TAX_PROFILE_FIELDS).filter((field) => field.type === "money").map((field) => field.key);

export function isSCorp(values = {}) {
  return values.entity_type === "s_corp" || values.tax_election === "s_corp";
}

export function isSoleOrDisregarded(values = {}) {
  return values.entity_type === "sole_proprietor" || (
    values.entity_type === "single_member_llc" && values.tax_election === "disregarded_entity"
  );
}

export function isFieldApplicable(field, values = {}) {
  if (!field?.applicableEntityPaths?.length) return true;
  if (field.key === "tax_election") return values.entity_type === "single_member_llc";
  if (field.key === "owner_reasonable_salary") return isSCorp(values);
  if (field.key === "self_employment_tax_applies") return isSoleOrDisregarded(values);
  return true;
}

export function optionLabel(options, value) {
  return options?.find((option) => option.value === value)?.label || value || "Missing";
}

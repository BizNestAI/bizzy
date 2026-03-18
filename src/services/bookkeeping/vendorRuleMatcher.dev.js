import { getVendorRuleForTransaction } from "./vendorRuleMatcher.js";

export async function runVendorRuleMatcherDevSamples(businessId) {
  const samples = [
    {
      label: "merchant_entity_id hit",
      txn: { merchant_entity_id: "ent_123", name: "Example Merchant", amount: -42.1 },
    },
    {
      label: "memo_prefix hit",
      txn: { name: "SQ *COFFEE SHOP 1234", amount: -5.75 },
    },
    {
      label: "regex hit",
      txn: { name: "PAYPAL *TOOLS", amount: -29.99 },
    },
    {
      label: "qbo entity hit",
      txn: { qbo_entity_type: "vendor", qbo_entity_id: "42", name: "Existing Vendor", amount: -12.3 },
    },
  ];

  for (const sample of samples) {
    const res = await getVendorRuleForTransaction({ businessId, bankTransaction: sample.txn });
    console.log(`[vendorRuleMatcher] ${sample.label}:`, res);
  }
}

// Example run (requires real businessId and data):
// node -e "import('./src/services/bookkeeping/vendorRuleMatcher.dev.js').then(m => m.runVendorRuleMatcherDevSamples('<business_id>'))"

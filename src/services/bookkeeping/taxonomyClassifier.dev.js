import { classifyTaxonomy } from "./taxonomyClassifier.js";

export function runTaxonomyDevSamples() {
  const samples = [
    {
      name: "Credit Card Payment Thank You",
      amount: -450.5,
      direction: "OUTFLOW",
    },
    {
      name: "Internal Transfer To Savings",
      amount: -250,
      direction: "OUTFLOW",
      personal_finance_category: { primary: "TRANSFER_OUT" },
    },
    {
      name: "Refund - Amazon Marketplace",
      amount: 32.12,
      direction: "INFLOW",
    },
    {
      name: "Owner Draw - Patrick",
      amount: -1200,
      direction: "OUTFLOW",
    },
    {
      name: "Owner Contribution - capital injection",
      amount: 5000,
      direction: "INFLOW",
    },
    {
      name: "PAYMENT TO CARD 1234",
      amount: -220,
      direction: "OUTFLOW",
      merchant_name: null,
    },
    {
      name: "Starbucks",
      amount: -8.75,
      direction: "OUTFLOW",
    },
  ];

  samples.forEach((sample, idx) => {
    const hit = classifyTaxonomy(sample, {});
    console.log(
      `[${idx + 1}] ${sample.name} -> ${hit ? `${hit.type} (${hit.confidence})` : "no taxonomy"}`,
      hit || ""
    );
  });
}

// To run manually:
// node -e "import('./src/services/bookkeeping/taxonomyClassifier.dev.js').then((m) => m.runTaxonomyDevSamples())"

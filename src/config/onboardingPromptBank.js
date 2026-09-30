// Scripted answers for the three pre-onboarding quick prompts.

const toneLines = [
  "Onboarding response behavior:",
  "- Be calm, concise, and practical.",
  "- Focus on completing account setup in this order: Business Profile, QuickBooks, Plaid, then Auto-post from Books Review.",
  "- Distinguish user setup tasks from service tasks handled with the Bizzi team, including file review, cleanup decisions, and bank-feed transition guidance.",
  "- Never imply that chat completed a connection, enabled Auto-post, or changed the books.",
  "- Avoid forced marketing language and unnecessary follow-up questions.",
];

export const ONBOARDING_TONE_BLOCK = toneLines.join("\n");

export const ONBOARDING_PROMPTS = [
  {
    id: "setup_biz",
    title: "How do I set up my business in Bizzi?",
    canonicalPrompt: "How do I set up my business in Bizzi?",
    matchers: [
      /^how (?:do|should) i (?:set up|setup) my business in bizzi\??$/i,
      /^(?:set up|setup) my business (?:in|with) bizzi\.?$/i,
      /^how (?:do|should) i get started (?:in|with) bizzi\??$/i,
      /^getting started (?:in|with) bizzi\.?$/i,
      /^(?:how (?:do|should) i )?complet(?:e|ing) (?:my )?bizzi setup\??$/i,
    ],
    response: `If you’re seeing this, your Bizzi login is already created. Complete the remaining setup in this order:

1. **Complete your Business Profile** so Bizzi has the correct company and operating context.
2. **Connect QuickBooks** from **Settings → Integrations** and select the correct company.
3. **Connect Plaid** from the same page and select the business checking and credit-card accounts you want Bizzi to monitor.
4. Go to **Books → Books Review** and turn on **Auto-post** once your connections are ready.

Transactions that need a decision will still appear in Needs Review. Once handled, eligible transactions remain in the 24-hour grace period before Bizzi posts them to QuickBooks.

During your onboarding call, we’ll review your QuickBooks setup and confirm whether any cleanup or bank-feed changes are needed. Don’t disconnect existing QuickBooks bank feeds unless we confirm that your file is ready.`,
  },
  {
    id: "sync_quickbooks_plaid",
    title: "How do I sync QuickBooks and Plaid?",
    canonicalPrompt: "How do I sync QuickBooks and Plaid?",
    matchers: [
      /^(?:how do i )?sync (?:my )?quickbooks and plaid\??$/i,
      /^(?:how do i )?sync plaid and quickbooks\??$/i,
      /^(?:how do i )?connect (?:my )?quickbooks and plaid\??$/i,
      /^(?:how do i )?connect plaid and quickbooks\??$/i,
      /^link quickbooks and plaid\.?$/i,
      /^how do i connect quickbooks\??$/i,
      /^(?:connect|link|sync) (?:my )?quickbooks\.?$/i,
      /^how do i connect plaid\??$/i,
      /^(?:connect|link|sync) (?:my )?plaid\.?$/i,
      /^(?:how do i )?connect (?:my )?bank accounts? (?:to|with) bizzi\??$/i,
    ],
    response: `Connect **QuickBooks first, then Plaid**:

1. Open **Settings → Integrations** and select **Connect QuickBooks**.
2. Sign in through Intuit and choose the correct QuickBooks company.
3. Return to Integrations and select **Connect Plaid**.
4. Connect the business checking and credit-card accounts Bizzi should monitor.
5. Once both connections are ready, go to **Books → Books Review** and turn on **Auto-post**.

QuickBooks is your accounting ledger. Plaid supplies the bank and credit-card activity Bizzi reviews for bookkeeping.

If QuickBooks already imports those same accounts through its own bank feeds, don’t disconnect them on your own. We’ll confirm the transition with you during onboarding to avoid missing or duplicated activity.`,
  },
  {
    id: "first_step",
    title: "What should I do first to get set up?",
    canonicalPrompt: "What should I do first to get set up?",
    matchers: [
      /^what should i do first(?: to get set up)?\??$/i,
      /^(?:what is the )?first (?:setup|set up) step\??$/i,
      /^where do i start(?: with bizzi)?\??$/i,
      /^(?:what are the )?first steps? after sign(?:ing)? up\??$/i,
    ],
    response: `If you’re already logged in, start by completing your **Business Profile**.

After that, connect **QuickBooks first**, connect **Plaid second**, and then turn on **Auto-post** from **Books → Books Review**.

We’ll help you verify the connections during your onboarding call, review the current state of your QuickBooks file, and let you know whether cleanup or bank-feed changes are needed before the monthly service begins.`,
  },
];

const promptMap = new Map(ONBOARDING_PROMPTS.map((entry) => [entry.id, entry]));

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

export function getOnboardingPromptById(id) {
  return promptMap.get(id) || null;
}

export function identifyOnboardingPrompt(text, hintId) {
  if (hintId && promptMap.has(hintId)) return promptMap.get(hintId);
  const normalized = normalize(text);
  if (!normalized) return null;
  for (const entry of ONBOARDING_PROMPTS) {
    if (normalize(entry.canonicalPrompt) === normalized) return entry;
    if (entry.matchers.some((matcher) => matcher.test(normalized))) return entry;
  }
  return null;
}

export function buildOnboardingToneBlock(topicTitle) {
  const topic = topicTitle ? `\nCurrent onboarding topic: "${topicTitle}".` : "";
  return `${ONBOARDING_TONE_BLOCK}${topic}`;
}

export function buildOnboardingGuide(entry) {
  if (!entry) return "";
  return [
    `### Onboarding Script: ${entry.title}`,
    "Use the verified script below. Keep its setup order and distinguish user tasks from service work. Never imply that chat completed an external action.",
    entry.response.trim(),
  ].join("\n\n");
}

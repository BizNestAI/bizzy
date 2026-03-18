// File: /src/config/onboardingPromptBank.js

const toneLines = [
  "Global onboarding tone:",
  "- Sound like a calm, experienced financial operator (ex-bookkeeper vibe) for busy tradespeople.",
  "- Avoid jargon. Use short paragraphs, bullets, and concrete examples.",
  "- Offer to do the task with them (say \"Let's do it now together\") instead of only explaining.",
  "- Never promise features that do not exist; if it is a roadmap idea, say \"over time we'll add...\" instead of guaranteeing it today.",
  "- Keep the first turn tight: 3-4 short paragraphs or bullet sections.",
  "- After you answer, call out one clear next action and ask a yes/no follow-up question.",
];

export const ONBOARDING_TONE_BLOCK = toneLines.join("\n");

const promptBank = [
  {
    id: "setup_biz",
    title: "Set up my business in Bizzi",
    canonicalPrompt: "How do I set up my business?",
    matchers: [
      /how (do|should) i (set up|setup).*bizzi/i,
      /set up my business.*bizzi/i,
      /how (do|should) i (set up|setup) my business\b/i,
      /\bset up my business\b/i,
      /\bgetting started with bizzi\b/i,
    ],
    response: `Great question. Let’s get Bizzi wired up as your **Autonomous Financial Operator** so it can keep your books clean without you babysitting it.

**1) Link bank accounts through Plaid (bank feed / transactions in)**
- Go to **Settings → Sync → Connect Plaid**
- Add the **checking + credit card** accounts used for this business
Bizzi pulls your transactions from Plaid, reviews them, and prepares them for clean posting.

**2) Connect QuickBooks next (ledger / posting destination)**
- Still in **Settings → Sync**, click **Connect QuickBooks**
- Sign in with Intuit and select the correct company file
This is where Bizzi posts the approved transactions so your books stay tax-ready.

**3) Turn off QuickBooks bank feeds (important)**
- In QuickBooks Online: **Transactions → Bank transactions**
- For each connected bank/credit card, click **pencil / Edit** (or account tile settings)
- Choose **Disconnect account** (or “Disconnect this account on save”)
- Repeat for each account (checking + cards)
Your QuickBooks ledger stays intact — this only stops QBO from importing the bank feed since Bizzi pulls via Plaid.

**4) Invite Bizzi to QuickBooks (monthly review)**
- Invite **books@bizzi.ai.com** as an **Accountant** so we can review your books monthly.

**After that: Do your first Books Review pass (5–10 minutes)**
- Go to **Financials → Books Review**
- Approve/edit the first batch (Bizzi learns vendor defaults fast)
- After a short grace window, Bizzi posts into QuickBooks automatically

**Optional: Finish your Business Profile**
Trade + team size helps Bizzi talk like an operator, but Bizzi can still run without it.

One clear next action: open **Settings → Sync** and connect **Plaid**, then **QuickBooks**.`,
    followUps: [
      "What trade are you in?",
      "Roughly how many transactions per month?",
      "Do you already use QuickBooks Online?",
      "Do you currently have your bank accounts connected in QuickBooks Bank Transactions?",
    ],
    followUpPrompt: "Want me to walk you through setup step-by-step (yes or no)?",
    nextStep: "Offer to walk them through the checklist step by step.",
    devNotes: [
      "Mention the checklist items with their current status (Plaid, QuickBooks, bank feeds off, QBO invite, profile).",
      "Plaid is always first: Bizzi ingests transactions via Plaid, then posts to QuickBooks.",
      "Remind the user to disconnect QuickBooks bank feeds to avoid duplicates; Bizzi uses Plaid as the bank feed.",
      "Have them invite books@bizzi.ai.com as an Accountant for monthly review once QBO is connected and bank feeds are off.",
      "Do NOT mention calendar/email/job tools in Phase 1 onboarding unless they exist again.",
    ],
    suggestedActions: [{ type: "show_checklist", checklistId: "bizzy_onboarding" }],
  },

  // ────────────────────────────────────────────────────────────────────────────
  // UPDATED: Sync prompt (Plaid first, then QuickBooks)
  // Keep old matchers so existing users typing the old phrase still hit this entry.
  // ────────────────────────────────────────────────────────────────────────────
  {
    id: "sync_quickbooks_plaid",
    title: "Sync Plaid and QuickBooks",
    canonicalPrompt: "How do I sync Plaid and QuickBooks?",
    matchers: [
      // New phrasing (Plaid first)
      /sync plaid and quickbooks/i,
      /connect plaid and quickbooks/i,

      // Alternate ordering users might type
      /sync quickbooks and plaid/i,
      /connect quickbooks and plaid/i,
      /link quickbooks and plaid/i,

      // Plaid-only phrasing
      /connect plaid/i,
      /sync plaid/i,
      /connect bank/i,
      /connect my bank/i,

      // Backward compatibility (old quick prompt text)
      /sync quickbooks/i,
      /connect quickbooks/i,
      /link quickbooks/i,
      /connect other accounts/i,
    ],
    response: `Syncing **Plaid → QuickBooks** is the core Bizzi workflow:
- **Plaid** = live bank/credit feed (transactions in)
- **QuickBooks** = accounting ledger (clean results posted out)

**Step 1 — Link bank accounts through Plaid (required)**
- Go to **Settings → Sync → Connect Plaid**
- Add the accounts used for this business (checking + cards)
Bizzi will start pulling transactions and staging them in **Books Review**.

**Step 2 — Connect QuickBooks (required for posting)**
- In **Settings → Sync**, click **Connect QuickBooks**
- Sign in with Intuit and pick the correct company file
Bizzi uses this to post approved transactions into your books.

**Step 3 — Turn off QuickBooks bank feeds (important)**
- In QuickBooks Online: **Transactions → Bank transactions**
- For each connected bank/credit card, click **pencil / Edit** (or account tile settings)
- Choose **Disconnect account** (or “Disconnect this account on save”)
- Repeat for each account (checking + cards)
Your QuickBooks ledger stays intact — this only stops QBO from importing the bank feed since Bizzi pulls via Plaid.

**Step 4 — Invite Bizzi to QuickBooks (monthly review)**
- Invite **books@bizzi.ai.com** as an **Accountant** so we can review your books monthly.

**After that — First cleanup pass**
- Go to **Financials → Books Review**
- Approve/edit categories (Bizzi learns vendor defaults so it gets quieter fast)

One clear next action: open **Settings → Sync** and connect **Plaid**, then **QuickBooks**.`,
    followUps: [
      "Do you want to connect checking or credit cards first?",
      "Is QuickBooks already set up for this business?",
      "Do you currently have your bank accounts connected in QuickBooks Bank Transactions?",
    ],
    followUpPrompt: "Want me to open Settings → Sync for you now (yes or no)?",
    nextStep:
      "Guide them through connecting Plaid first, then QuickBooks, then turning off bank feeds, then inviting books@bizzi.ai.com, then a first Books Review pass.",
    devNotes: [
      "Plaid is always step 1: Bizzi needs Plaid to see transactions.",
      "QuickBooks is step 2: Bizzi needs QBO connected to post approved transactions.",
      "Remind the user to disconnect QuickBooks bank feeds to avoid duplicates; Bizzi uses Plaid as the bank feed.",
      "Have them invite books@bizzi.ai.com as an Accountant for monthly review after bank feeds are off.",
      "If user does not use QuickBooks: reassure them Bizzi can still help with cash/spend visibility via Plaid, but posting + tax readiness is best with QuickBooks.",
    ],
    suggestedActions: [
      {
        type: "navigate",
        label: "Open Sync settings",
        target: "/dashboard/settings?tab=Integrations",
      },
    ],
  },

  {
    id: "daily_use",
    title: "Best way to use Bizzi day-to-day",
    canonicalPrompt: "What's the best way to use Bizzi day-to-day?",
    matchers: [
      /best way to use bizzi/i,
      /how to use bizzi (every|each) day/i,
      /day[- ]to[- ]day bizzi/i,
    ],
    response: `Think of Bizzi like your always-on financial operator — you do tiny approvals, and the books stay clean automatically.

**Daily (1–2 minutes)**
- Open **Financials → Books Review**
- Approve anything flagged
- Ask: “Anything urgent in my books today?”

**Weekly (5 minutes)**
- Ask: “Give me a cash + profit snapshot.”
- Ask: “What changed since last week?”

**Monthly (10–15 minutes)**
- Do one cleanup pass
- Ask: “Top 3 cost drivers this month?”
- Ask: “Any tax surprises building up?”

The goal is consistency: small approvals beat month-end catch-up.`,
    followUps: [
      "Do you run mostly card spend or mostly checking?",
      "What matters more right now: profit, cash flow, or tax surprises?",
    ],
    followUpPrompt: "Want a simple Bizzi routine tailored to your workflow (yes or no)?",
    nextStep: "Offer to tailor a routine once they answer the quick questions.",
    devNotes: [
      "Keep this focused on financial ops (books, cash, tax readiness).",
      "Avoid mentioning jobs/email/calendar modules.",
    ],
    suggestedActions: [],
  },

  {
    id: "bizzi_value",
    title: "How Bizzi helps run the business",
    canonicalPrompt: "How does Bizzi help me run my business?",
    matchers: [/how does bizzi help/i, /what does bizzi do/i, /why should i use bizzi/i],
    response: `Bizzi is an **Autonomous Financial Operator** for trades & home services. It removes the “I should probably do my books…” mental load.

**What Bizzi owns**
- **Bookkeeping flow:** Plaid pulls transactions → Bizzi categorizes → you approve edge cases → Bizzi posts to QuickBooks
- **Clean books signal:** keeps you aware of what’s still “Needs Review” so reports aren’t lying
- **Cash + profit clarity:** explains what changed and what’s driving spend
- **Tax readiness:** keeps deductions visible and flags surprises early (planning, not filing)
- Reminder: if you use QuickBooks, turn off its bank feeds (Transactions → Bank transactions → disconnect) so Bizzi is the single feed via Plaid; your ledger stays intact.

If you want: Bizzi can be strict and opinionated — “Here’s what matters this week, and why.”`,
    followUps: [
      "What’s the biggest pain right now: bookkeeping, cash surprises, or tax stress?",
    ],
    followUpPrompt: "Want me to diagnose that in 2 minutes (yes or no)?",
    nextStep: "Offer concrete help on the pain area they mention.",
    devNotes: [
      "No cofounder framing; emphasize operator + books + tax readiness + cash clarity.",
    ],
    suggestedActions: [],
  },

  {
    id: "first_step",
    title: "What to do first to get set up",
    canonicalPrompt: "What should I do first to get set up?",
    matchers: [/what should i do first/i, /first step to get set up/i, /where do i start/i],
    response: `Start with the shortest path to value:

**Step 1 — Link bank accounts through Plaid (transactions in)**
Bizzi can’t help until it can see your real bank/credit activity.

**Step 2 — Connect QuickBooks (posting destination)**
So Bizzi can write the cleaned-up results into your ledger for tax season.

**Step 3 — Turn off QuickBooks bank feeds (important)**
- In QuickBooks: **Transactions → Bank transactions → pencil/Edit → Disconnect account** for each connected bank/card

**Step 4 — Invite Bizzi to QuickBooks (monthly review)**
- Invite **books@bizzi.ai.com** as an **Accountant** so we can review your books monthly.

After that, do your first Books Review pass:
Approve/edit a handful of transactions so Bizzi learns your vendor defaults and stops asking.

One clear next action: open **Settings → Sync** and connect **Plaid**, then **QuickBooks**.`,
    followUps: ["Do you want to connect checking or credit cards first?"],
    followUpPrompt: "Ready to do that first step now (yes or no)?",
    nextStep:
      "Guide them through Plaid first; then QuickBooks; then turning off bank feeds; then inviting books@bizzi.ai.com; then Books Review.",
    devNotes: [
      "This must always recommend Plaid first.",
    ],
    suggestedActions: [{ type: "show_checklist", checklistId: "bizzy_onboarding" }],
  },

  // ────────────────────────────────────────────────────────────────────────────
  // REMOVED:
  // connect_jobs_email_calendar (no longer active in product right now)
  // ────────────────────────────────────────────────────────────────────────────

  {
    id: "what_is_bizzi",
    title: "What is Bizzi?",
    canonicalPrompt: "What exactly is Bizzi?",
    matchers: [/what (is|exactly is) bizzi/i, /explain bizzi/i, /who are you bizzi/i],
    response: `Bizzi is an **Autonomous Financial Operator** for contractors and home service businesses.

In plain terms:
- **Plaid pulls** your bank/credit transactions
- Bizzi **categorizes + learns** your vendor defaults
- You approve what needs review
- Bizzi **posts to QuickBooks** after a short grace window
- Turn off QuickBooks bank feeds (in QBO: **Transactions → Bank transactions → pencil/Edit → Disconnect account**) so Bizzi is the single source; your ledger stays intact.

So your books stay clean continuously — not just at month-end — and you can ask Bizzi “Where did my profit go?” and get an answer in plain English.`,
    followUps: [],
    followUpPrompt: "",
    nextStep: "Invite them to connect Plaid + QuickBooks for full value.",
    devNotes: ["Keep it concrete: Plaid → Review → Post to QuickBooks."],
    suggestedActions: [],
  },

  {
    id: "who_is_bizzi_for",
    title: "Who is Bizzi for?",
    canonicalPrompt: "Who is Bizzi for?",
    matchers: [/who is bizzi for/i, /bizzi.*for (what|which) businesses/i],
    response: `Bizzi is for trades + home services owners who want their books handled without babysitting software:
- HVAC, plumbing, electrical, roofing, remodeling/GCs, landscaping, cleaning, pressure washing, etc.
- Especially useful if you hate categorizing transactions or only open QuickBooks at tax time.`,
    followUps: [],
    followUpPrompt: "",
    nextStep: "Ask what trade they’re in so Bizzi can tailor categories and examples.",
    devNotes: [],
    suggestedActions: [],
  },

  {
    id: "what_can_bizzi_do_now",
    title: "Current Bizzi capabilities",
    canonicalPrompt: "What can Bizzi help me with right now?",
    matchers: [/what can bizzi help.*now/i, /what does bizzi do right now/i],
    response: `Right now Bizzi is strongest as a financial operator:

1) **Books Review + posting to QuickBooks**
- Pulls transactions via Plaid
- Suggests categories + vendor defaults
- After approval, posts to QuickBooks automatically

2) **Clarity on your numbers**
- Revenue/expense/profit trends
- “What changed?” and “What’s driving spend?” answers

3) **Tax readiness basics**
- Deduction visibility
- Early warnings (planning, not filing)

If you connect Plaid + QuickBooks, Bizzi stops guessing and starts using your real numbers. If you use QBO, disable its bank feeds (Transactions → Bank transactions → disconnect) to avoid duplicates because Bizzi pulls via Plaid.`,
    followUps: [],
    followUpPrompt: "Want me to help you connect Plaid + QuickBooks (yes or no)?",
    nextStep: "Guide them toward Settings → Sync.",
    devNotes: ["Do not mention calendar/email/job tools here."],
    suggestedActions: [],
  },

  {
    id: "future_capabilities",
    title: "Future of Bizzi",
    canonicalPrompt: "What will Bizzi be able to do in the future?",
    matchers: [/what will bizzi.*future/i, /future plans for bizzi/i],
    response: `The direction is “more autonomy, fewer questions,” without losing correctness.

Over time we’ll add things like:
- Deeper job costing/profitability workflows
- More automated follow-ups and “financial hygiene” tasks
- Stronger reconciliation signals and alerts

Bizzi will stay conservative about changes that affect your ledger — you’ll always have visibility and control.`,
    followUps: [],
    followUpPrompt: "",
    nextStep: "",
    devNotes: ["Future wording only. Don’t promise specific integrations unless they exist."],
    suggestedActions: [],
  },

  {
    id: "what_to_do_first",
    title: "What should I do first after signing up?",
    canonicalPrompt: "What should I do first after signing up?",
    matchers: [/what should i do first after signing up/i, /first steps after sign up/i],
    response: `Do these in order:

1) Link bank accounts through **Plaid** (so Bizzi can see your transactions)
2) Connect **QuickBooks** (so Bizzi can post clean results)
3) Turn off QuickBooks bank feeds
   - In QBO: **Transactions → Bank transactions → pencil/Edit → Disconnect account** for each connected bank/card (prevents duplicate feeds; Bizzi pulls via Plaid)
4) Invite **books@bizzi.ai.com** as an **Accountant** to review your books monthly

After that, open **Books Review** and approve the first batch.
(Optional) Complete your business profile when you have a minute.

That first approval pass teaches Bizzi how your vendors map to your accounts.`,
    followUps: [],
    followUpPrompt: "Want me to walk you through those steps right now (yes or no)?",
    nextStep:
      "If yes, guide them through Plaid, then QuickBooks, then turning off bank feeds, then inviting books@bizzi.ai.com, then Books Review.",
    devNotes: ["Always Plaid first."],
    suggestedActions: [],
  },

  {
    id: "connect_quickbooks_faq",
    title: "How do I connect QuickBooks?",
    canonicalPrompt: "How do I connect QuickBooks?",
    matchers: [/how do i connect quickbooks/i, /connect qb online/i],
    response:
      "To connect QuickBooks (so Bizzi can post into your ledger):\n\n" +
      "- Go to **Settings → Sync**\n" +
      "- Click **Connect QuickBooks**\n" +
      "- Sign in with Intuit\n" +
      "- Select the correct company file for this business\n\n" +
      "QuickBooks is the destination — Bizzi still pulls transactions from Plaid.\n\n" +
      "After you connect, turn off QuickBooks bank feeds to prevent duplicates:\n" +
      "- In QBO: **Transactions → Bank transactions → pencil/Edit → Disconnect account** for each connected bank/card\n" +
      "This keeps your ledger intact and avoids double-imports because Bizzi pulls via Plaid.\n\n" +
      "Then invite **books@bizzi.ai.com** as an **Accountant** so we can review your books monthly.",
    followUps: [],
    followUpPrompt: "Want me to open Settings → Sync for you (yes or no)?",
    nextStep: "Use the navigate action to open Sync when they agree.",
    devNotes: [
      "Keep it clear: Plaid = bank feed, QuickBooks = ledger. Remind them to disconnect QBO bank feeds after connecting to avoid duplicates.",
      "Have them invite books@bizzi.ai.com as an Accountant for monthly review.",
    ],
    suggestedActions: [
      { type: "navigate", label: "Open Sync settings", target: "/dashboard/settings?tab=Integrations" },
    ],
  },

  {
    id: "connect_plaid_faq",
    title: "How do I connect Plaid?",
    canonicalPrompt: "How do I connect Plaid?",
    matchers: [
      /how do i connect plaid/i,
      /connect plaid/i,
      /link plaid/i,
      /sync plaid/i,
      /connect bank/i,
      /connect my bank/i,
    ],
    response: `To connect Plaid (so Bizzi can pull transactions automatically):

- Go to **Settings → Sync**
- Click **Connect Plaid**
- Select your bank and sign in securely through Plaid
- Choose the accounts you want Bizzi to monitor (checking + cards)

After that, Bizzi starts pulling transactions into Books Review so you can approve and keep everything clean.

After you connect Plaid (and QuickBooks), turn off QuickBooks bank feeds to avoid duplicates:
- In QBO: **Transactions → Bank transactions → pencil/Edit → Disconnect account** for each connected bank/card
This just stops QBO importing the feed; Bizzi pulls through Plaid instead.

Once QuickBooks is connected and bank feeds are off, invite **books@bizzi.ai.com** as an **Accountant** so we can review your books monthly.`,
    followUps: [],
    followUpPrompt: "Want me to open Settings → Sync now (yes or no)?",
    nextStep: "Navigate to Settings → Sync when they agree.",
    devNotes: ["Plaid is always the first integration for Bizzi."],
    suggestedActions: [
      { type: "navigate", label: "Open Sync settings", target: "/dashboard/settings?tab=Integrations" },
    ],
  },

  {
    id: "no_quickbooks",
    title: "What if I don't use QuickBooks?",
    canonicalPrompt: "What if I don’t use QuickBooks or these tools yet?",
    matchers: [/what if i don't use quickbooks/i, /i don't use qb/i, /no quickbooks/i],
    response: `You can still use Bizzi with **Plaid-only** to understand cash flow and spending.

But for clean books + tax readiness, QuickBooks is the easiest ledger for most trades businesses:
- Bizzi pulls transactions via Plaid
- Bizzi posts into QuickBooks
- Your CPA can file year-end taxes cleanly

If you want, tell me your trade + rough revenue, and I’ll recommend the simplest setup that won’t become a mess at tax time.`,
    followUps: [],
    followUpPrompt: "Want help deciding whether you should use QuickBooks (yes or no)?",
    nextStep: "If yes, ask trade + team size + how they invoice today.",
    devNotes: [],
    suggestedActions: [],
  },

  {
    id: "best_daily_routine",
    title: "How to use Bizzi every day",
    canonicalPrompt: "What’s the best way to use Bizzi every day?",
    matchers: [/best way to use bizzi every day/i, /daily routine for bizzi/i],
    response: `Here’s the simple routine that keeps your books clean with minimal effort:

- **2 minutes/day:** open Books Review → approve what’s flagged  
- **5 minutes/week:** ask “What changed?” + “Anything urgent?”  
- **10 minutes/month:** quick cleanup pass + tax-ready check

Small consistent actions beat heroic month-end catch-up.`,
    followUps: [],
    followUpPrompt: "Want me to tailor that routine to your transaction volume (yes or no)?",
    nextStep: "If yes, ask how many transactions/month they typically have.",
    devNotes: [],
    suggestedActions: [],
  },

  {
    id: "question_examples",
    title: "What questions can I ask?",
    canonicalPrompt: "What kinds of questions can I ask Bizzi?",
    matchers: [/what (kind|types) of questions can i ask/i, /what can i ask bizzi/i],
    response: `Examples that Bizzi is built for:

- “What’s my cash situation this week?”
- “Why is profit down this month?”
- “What’s my top spending category right now?”
- “Anything in my books that looks wrong?”
- “What transactions still need review?”
- “What should I clean up before tax time?”

If Plaid + QuickBooks are connected, Bizzi answers using your actual numbers (not generic advice).`,
    followUps: [],
    followUpPrompt: "Want to try one on your real data (yes or no)?",
    nextStep: "If yes, suggest they connect Plaid + QuickBooks if not already.",
    devNotes: [],
    suggestedActions: [],
  },

  {
    id: "can_bizzi_take_actions",
    title: "Can Bizzi take actions automatically?",
    canonicalPrompt: "Can Bizzi take actions for me automatically?",
    matchers: [/can bizzi take actions/i, /does bizzi automate/i],
    response: `Bizzi automates the bookkeeping flow in a controlled way:

- Pulls transactions via Plaid
- Suggests categories and learns vendor defaults
- Posts to QuickBooks after approval and a grace window

Bizzi won’t silently make big ledger changes without you having visibility.`,
    followUps: [],
    followUpPrompt: "",
    nextStep: "",
    devNotes: [],
    suggestedActions: [],
  },

  {
    id: "bookkeeper_question",
    title: "Does Bizzi replace my bookkeeper?",
    canonicalPrompt: "Does Bizzi replace my bookkeeper or accountant?",
    matchers: [/replace my bookkeeper/i, /replace my accountant/i],
    response: `Bizzi can replace a monthly bookkeeper for many small trades businesses — and your CPA can still handle year-end taxes.

Typical setup:
- Bizzi runs day-to-day categorization + posting
- You approve edge cases
- A CPA reviews at year-end and files

Bizzi does not “act as a CPA,” and it does not file taxes — but it can keep your books clean so tax time is painless.`,
    followUps: [],
    followUpPrompt: "",
    nextStep: "",
    devNotes: [],
    suggestedActions: [],
  },

  {
    id: "data_access_faq",
    title: "What data does Bizzi access?",
    canonicalPrompt: "What data do you access from my tools?",
    matchers: [/what data do.*access/i, /what data does bizzi see/i],
    response: `Bizzi only accesses data from integrations you connect.

- **Plaid:** transaction metadata, amounts, dates, merchant info (categorization)
- **QuickBooks:** chart of accounts + the ledger where Bizzi posts

You control connections. Disconnect any time in Settings.`,
    followUps: [],
    followUpPrompt: "",
    nextStep: "",
    devNotes: ["Keep this aligned with current active integrations (Plaid + QuickBooks)."],
    suggestedActions: [],
  },

  {
    id: "data_security_faq",
    title: "How is data stored and protected?",
    canonicalPrompt: "How does Bizzi store and protect my data?",
    matchers: [/how does bizzi store/i, /data security/i],
    response: `Bizzi is built with “bank-grade” practices in mind:

- HTTPS in transit
- Encrypted storage at rest
- Row-level security so businesses only see their own records
- OAuth integrations (Bizzi never asks for your QuickBooks password)

You can disconnect integrations any time, and you can request deletion per the Privacy Policy.`,
    followUps: [],
    followUpPrompt: "",
    nextStep: "",
    devNotes: [],
    suggestedActions: [],
  },

  {
    id: "model_training_faq",
    title: "Does Bizzi train models on my data?",
    canonicalPrompt: "Does Bizzi train the AI model on my data?",
    matchers: [/train.*model.*data/i, /do you train on my data/i],
    response: `No — your identifiable business data is not used to train public AI models.

Bizzi uses AI to generate responses, but your connected data is used only to answer your questions and run your bookkeeping workflows.`,
    followUps: [],
    followUpPrompt: "",
    nextStep: "",
    devNotes: [
      "Keep this conservative. Do not claim anything about vendor training programs beyond what you are confident about.",
    ],
    suggestedActions: [],
  },

  {
    id: "pricing_faq",
    title: "How much does Bizzi cost?",
    canonicalPrompt: "How much does Bizzi cost?",
    matchers: [/how much does bizzi cost/i, /what's the price/i],
    response: `Bizzi is a monthly subscription. Pricing is shown on the Pricing page and inside the app.

If you tell me your rough monthly transaction volume (low / medium / high), I can also tell you whether Bizzi is a good fit right now.`,
    followUps: [],
    followUpPrompt: "",
    nextStep: "",
    devNotes: ["Don’t hardcode pricing unless your pricing is finalized in-product."],
    suggestedActions: [],
  },

  {
    id: "trial_faq",
    title: "Is there a free trial?",
    canonicalPrompt: "Is there a free trial?",
    matchers: [/is there a free trial/i, /trial for bizzi/i],
    response: `If a free trial is active in your account, you’ll see it in Billing.

Best way to use a trial:
- Connect Plaid + QuickBooks
- Do one Books Review pass
- Ask Bizzi 2–3 questions about profit, cash, and spending

That’s when the value becomes obvious.`,
    followUps: [],
    followUpPrompt: "",
    nextStep: "",
    devNotes: ["Keep generic; trial mechanics may change."],
    suggestedActions: [],
  },

  {
    id: "cancel_faq",
    title: "Can I cancel anytime?",
    canonicalPrompt: "Can I cancel my subscription anytime?",
    matchers: [/can i cancel.*anytime/i, /cancel subscription/i],
    response: `Yes — you can cancel any time via Billing settings. Billing stops at the end of the current period.`,
    followUps: [],
    followUpPrompt: "",
    nextStep: "",
    devNotes: [],
    suggestedActions: [],
  },

  {
    id: "data_after_cancel",
    title: "What happens to my data if I leave?",
    canonicalPrompt: "What happens to my data if I stop using Bizzi?",
    matchers: [/what happens to my data/i, /data.*after cancel/i],
    response: `Once you disconnect integrations and cancel:
- Bizzi stops pulling new data
- Existing records may be retained temporarily for security/audit/legal reasons
- You can request deletion per the Privacy Policy`,
    followUps: [],
    followUpPrompt: "",
    nextStep: "",
    devNotes: [],
    suggestedActions: [],
  },

  {
    id: "fallback_guardrail",
    title: "Fallback for unsupported requests",
    canonicalPrompt: "Fallback: When user asks for something Bizzi can't do",
    matchers: [
      /can you (file taxes|run payroll|automate invoicing|push transactions)/i,
      /do .* in quickbooks/i,
      /not supported yet/i,
    ],
    response:
      "I get why you’d want that — and over time we’ll expand automation. But I won’t pretend something exists when it doesn’t.\n\n" +
      "Right now Bizzi focuses on:\n" +
      "- Keeping books clean via Plaid → review → posting to QuickBooks\n" +
      "- Translating your numbers into clear next steps\n" +
      "- Tax readiness and cash/profit clarity\n\n" +
      "If you tell me what you’re trying to accomplish, I can either:\n" +
      "1) walk you through the best current workflow, or\n" +
      "2) tell you what’s realistic to automate next.",
    followUps: [],
    followUpPrompt: "",
    nextStep: "",
    devNotes: [
      "Examples of unsupported actions: file taxes, run payroll, fully automate invoicing, etc.",
    ],
    suggestedActions: [],
  },
];

const promptMap = new Map(promptBank.map((entry) => [entry.id, entry]));

function normalize(str) {
  return (str || "").trim().toLowerCase();
}

export function getOnboardingPromptById(id) {
  return promptMap.get(id) || null;
}

export function identifyOnboardingPrompt(text, hintId) {
  if (hintId && promptMap.has(hintId)) {
    return promptMap.get(hintId);
  }
  const norm = normalize(text);
  if (!norm) return null;
  for (const entry of promptBank) {
    if (entry.canonicalPrompt && normalize(entry.canonicalPrompt) === norm) {
      return entry;
    }
    if (entry.matchers?.some((re) => re.test(norm))) {
      return entry;
    }
  }
  return null;
}

export function buildOnboardingToneBlock(topicTitle) {
  const note = topicTitle ? `\nYou are currently answering the onboarding topic "${topicTitle}".` : "";
  return `${ONBOARDING_TONE_BLOCK}${note}`;
}

export function buildOnboardingGuide(entry, context = {}) {
  if (!entry) return "";
  const parts = [];
  parts.push(`### Onboarding Script: ${entry.title}`);
  parts.push(
    "Use the script below as the response. Keep numbered steps in order and do not omit any required onboarding steps."
  );
  parts.push(entry.response.trim());
  if (context.checklist) {
    parts.push(`Current checklist snapshot:\n${context.checklist}`);
  }
  if (entry.nextStep) {
    parts.push(`Next-step CTA: ${entry.nextStep}`);
  }
  if (entry.followUps?.length) {
    parts.push(
      "Ask these follow-up questions conversationally:",
      entry.followUps.map((q) => `- ${q}`).join("\n")
    );
  }
  if (entry.followUpPrompt) {
    parts.push(`Yes/no follow-up to end with: ${entry.followUpPrompt}`);
  }
  if (entry.devNotes?.length) {
    parts.push(
      "Implementation notes:",
      entry.devNotes.map((note) => `- ${note}`).join("\n")
    );
  }
  return parts.filter(Boolean).join("\n\n");
}

export const ONBOARDING_PROMPT_BANK = promptBank;

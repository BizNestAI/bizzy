// Universal Vendor Intelligence Library
// Provides global, non-binding vendor intent hints (no business-specific COA).
// Keep this pure JS: no network, no DB. Intent-only hints to be mapped later.

const TRUE_NOISE_PREFIXES = [
  /^sq\s*\*/i,
  /^square\s*\*/i,
  /^clover\s*\*/i,
  /^paypal\s*\*/i,
  /^venmo\s*\*/i,
  /^pp\s*\*/i,
  /^cash\s*app\s*/i,
  /^google\s*\*/i,
];

const PHRASE_NORMALIZERS = [
  { pattern: /\b(uber)\s*trip\b/i, replace: "$1" },
  { pattern: /\b(lyft)\s*ride\b/i, replace: "$1" },
  { pattern: /\bapple\.?com\/?bill\b/i, replace: "apple" },
];

export function normalizeVendorString(input = "") {
  let s = (input || "").toLowerCase();
  TRUE_NOISE_PREFIXES.forEach((re) => {
    s = s.replace(re, "");
  });
  PHRASE_NORMALIZERS.forEach(({ pattern, replace }) => {
    s = s.replace(pattern, replace);
  });
  s = s.replace(/[^a-z0-9\s]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

const UNIVERSAL_VENDOR_HINTS = [];

function addVendors(list, config) {
  const {
    primary,
    intents,
    matchType = "contains",
    confidence = "medium",
    notes = null,
  } = config;
  list.forEach((name) => {
    const key = name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    UNIVERSAL_VENDOR_HINTS.push({
      key,
      match: { type: matchType, value: normalizeVendorString(name) },
      canonical: name,
      intents,
      primary_intent: primary || intents[0],
      confidence,
      notes,
    });
  });
}

// Fuel / Auto
addVendors(
  [
    "Shell",
    "Chevron",
    "Texaco",
    "BP",
    "Exxon",
    "Mobil",
    "Arco",
    "Phillips 66",
    "76 Gas",
    "Valero",
    "Costco Gas",
    "Sam's Club Fuel",
    "Circle K",
    "Speedway",
    "Sppedway",
    "Pilot Travel Center",
    "Flying J",
    "Love's Travel Stop",
    "QuikTrip",
    "QuickTrip",
    "Wawa",
    "Spinx",
    "Casey's",
    "Sunoco",
    "GetGo",
    "Kum & Go",
    "RaceTrac",
    "Rutter's",
    "Sheetz",
  ],
  { intents: ["fuel"], primary: "fuel", confidence: "high", notes: "Fuel / gas" }
);

// Travel - rideshare
addVendors(["Uber", "Lyft", "Via", "Lime"], {
  intents: ["transportation", "rideshare"],
  primary: "transportation",
  confidence: "high",
  notes: "Rideshare",
});

// Airlines
addVendors(
  [
    "Delta",
    "United",
    "American Airlines",
    "Southwest",
    "Alaska Airlines",
    "JetBlue",
    "Frontier Airlines",
    "Spirit Airlines",
    "Hawaiian Airlines",
    "Air Canada",
    "Lufthansa",
    "British Airways",
    "KLM",
    "Air France",
    "Qatar Airways",
    "Emirates",
    "Turkish Airlines",
    "WestJet",
    "Aeromexico",
    "Copa Airlines",
  ],
  { intents: ["travel", "airfare"], primary: "airfare", confidence: "high" }
);

// Hotels / Lodging
addVendors(
  [
    "Marriott",
    "Hilton",
    "Hyatt",
    "IHG",
    "Holiday Inn",
    "Crowne Plaza",
    "Embassy Suites",
    "Hampton Inn",
    "Courtyard",
    "Residence Inn",
    "Fairfield Inn",
    "Ritz Carlton",
    "W Hotels",
    "Sheraton",
    "Westin",
    "Four Points",
    "Aloft",
    "DoubleTree",
    "Homewood Suites",
    "Best Western",
    "Choice Hotels",
    "Comfort Inn",
    "Comfort Suites",
    "Quality Inn",
    "Motel 6",
    "Red Roof Inn",
    "La Quinta",
    "Drury Inn",
    "Sonesta",
    "Omni Hotels",
    "Loews Hotels",
    "Airbnb",
    "VRBO",
    "Expedia",
    "Booking.com",
    "Hotels.com",
  ],
  { intents: ["travel", "lodging"], primary: "lodging", confidence: "high" }
);

// Car rental / mobility
addVendors(
  [
    "Hertz",
    "Avis",
    "Budget",
    "Enterprise",
    "National Car Rental",
    "Alamo",
    "Thrifty",
    "Dollar Rent A Car",
    "Sixt",
    "Zipcar",
    "Turo",
    "Getaround",
  ],
  { intents: ["travel", "car_rental"], primary: "car_rental", confidence: "high" }
);

// Shipping / postage
addVendors(
  ["FedEx", "UPS", "USPS", "DHL", "Purolator", "Canada Post", "Royal Mail", "Aramex", "OnTrac", "Lasership"],
  { intents: ["shipping", "postage"], primary: "shipping", confidence: "high" }
);

// Office / supplies
addVendors(
  ["Staples", "Office Depot", "OfficeMax", "Quill", "WB Mason"],
  { intents: ["office_supplies"], primary: "office_supplies", confidence: "high" }
);

// Big box / retail / warehouse
addVendors(
  ["Amazon", "Amazon Marketplace", "Costco", "Costco Wholesale"],
  { intents: ["materials"], primary: "materials", confidence: "medium", notes: "Warehouse supplies / materials; review if personal or grocery-only" }
);

addVendors(
  ["Walmart", "Target", "Walgreens", "Walgreens Pharmacy"],
  { intents: ["materials"], primary: "materials", confidence: "medium", notes: "Retail supplies / materials; review if personal-only" }
);

addVendors(
  ["Costco", "Sam's Club", "BJ's Wholesale", "Kroger", "Safeway", "Albertsons", "Meijer", "H-E-B", "Aldi", "Lidl", "Trader Joe's"],
  { intents: ["supplies"], primary: "supplies", confidence: "medium" }
);

// Hardware / materials / tools (contractor heavy)
addVendors(
  [
    "Home Depot",
    "Lowe's",
    "Menards",
    "Ace Hardware",
    "True Value",
    "Do it Best",
    "Harbor Freight",
    "Northern Tool",
    "Fastenal",
    "Grainger",
    "Ferguson",
    "SupplyHouse",
    "HD Supply",
    "White Cap",
    "Johnstone Supply",
    "Graybar",
    "Wesco",
    "Rexel",
    "Crescent Electric",
    "MSC Industrial",
    "Applied Industrial",
    "Motion Industries",
    "Uline",
    "McMaster-Carr",
    "Fastenal Company",
    "Fastco",
    "Fastener Supply",
    "Ferguson Enterprises",
    "Ferguson Plumbing",
    "Ferguson HVAC",
    "Sherwin-Williams",
    "Benjamin Moore",
    "PPG Paints",
    "Dunn-Edwards",
    "Kelly-Moore Paints",
    "Behr",
    "Valspar",
    "John Deere",
    "Caterpillar",
    "SparkFun",
    "SparkFun Electronics",
    "Tractor Supply",
    "Rural King",
  ],
  {
    intents: ["materials", "tools", "equipment"],
    primary: "materials",
    confidence: "high",
    notes: "Construction / trades suppliers",
  }
);

// Restaurants / meals / coffee (common chains)
addVendors(
  [
    "McDonald's",
    "Burger King",
    "Wendy's",
    "Chick-fil-A",
    "KFC",
    "Popeyes",
    "Taco Bell",
    "Chipotle",
    "Panera Bread",
    "Subway",
    "Jimmy John's",
    "Jersey Mike's",
    "Five Guys",
    "In-N-Out",
    "Shake Shack",
    "Starbucks",
    "Dunkin",
    "Peet's Coffee",
    "Dutch Bros",
    "Tim Hortons",
    "Caribou Coffee",
    "Einstein Bros Bagels",
    "Cava",
    "Sweetgreen",
    "Jamba Juice",
    "Smoothie King",
    "Domino's",
    "Pizza Hut",
    "Papa John's",
    "Little Caesars",
    "Wingstop",
    "Buffalo Wild Wings",
    "Olive Garden",
    "Cheesecake Factory",
    "Panda Express",
    "Qdoba",
    "Moe's Southwest Grill",
    "Tropical Smoothie Cafe",
    "Potbelly",
    "Firehouse Subs",
    "Arby's",
    "Sonic Drive-In",
    "Dairy Queen",
    "Culver's",
    "Whataburger",
    "Jack in the Box",
    "Carl's Jr.",
    "Hardee's",
    "Raising Cane's",
    "Zaxby's",
    "Bojangles",
    "Del Taco",
    "Noodles & Company",
    "Jason's Deli",
    "Corner Bakery",
    "Au Bon Pain",
    "Pret A Manger",
    "First Watch",
    "The Habit Burger Grill",
    "MOD Pizza",
    "Blaze Pizza",
    "California Pizza Kitchen",
    "P.F. Chang's",
    "Texas Roadhouse",
    "Outback Steakhouse",
    "LongHorn Steakhouse",
    "Chili's",
    "Applebee's",
    "TGI Fridays",
    "Red Robin",
    "Red Lobster",
    "Cracker Barrel",
    "IHOP",
    "Denny's",
    "Waffle House",
    "Publix",
    "Whole Foods",
    "Whole Foods Market",
    "Lowes Foods",
    "DoorDash",
    "Uber Eats",
    "Crumbl",
    "Micro Mart",
    "Short Stop",
    "PoppyCox",
  ],
  { intents: ["meals"], primary: "meals", confidence: "high" }
);

// QuickBooks / Intuit deposits and merchant fees
UNIVERSAL_VENDOR_HINTS.push(
  {
    key: "intuit_deposit_invoice_revenue",
    match: { type: "contains", value: "deposit intuit" },
    canonical: "Intuit Deposit",
    intents: ["sales"],
    primary_intent: "sales",
    confidence: "high",
    notes: "QuickBooks/Intuit invoice deposit; generally sales revenue",
  },
  {
    key: "intuit_deposit_invoice_revenue_reverse",
    match: { type: "contains", value: "intuit deposit" },
    canonical: "Intuit Deposit",
    intents: ["sales"],
    primary_intent: "sales",
    confidence: "high",
    notes: "QuickBooks/Intuit invoice deposit; generally sales revenue",
  },
  {
    key: "intuit_transaction_fee",
    match: { type: "contains", value: "tran fee intuit" },
    canonical: "Intuit Transaction Fee",
    intents: ["bank_fees"],
    primary_intent: "bank_fees",
    confidence: "high",
    notes: "QuickBooks/Intuit card or ACH processing fee",
  },
  {
    key: "intuit_transaction_fee_reverse",
    match: { type: "contains", value: "intuit transaction fee" },
    canonical: "Intuit Transaction Fee",
    intents: ["bank_fees"],
    primary_intent: "bank_fees",
    confidence: "high",
    notes: "QuickBooks/Intuit card or ACH processing fee",
  }
);

// Utilities with specific account intent
UNIVERSAL_VENDOR_HINTS.push(
  {
    key: "att_internet_services",
    match: { type: "contains", value: "at t" },
    canonical: "AT&T",
    intents: ["internet_services", "utilities"],
    primary_intent: "internet_services",
    confidence: "high",
    notes: "Internet / telecom utility",
  },
  {
    key: "att_payment_internet_services",
    match: { type: "contains", value: "payment att" },
    canonical: "AT&T",
    intents: ["internet_services", "utilities"],
    primary_intent: "internet_services",
    confidence: "high",
    notes: "Internet / telecom utility payment",
  },
  {
    key: "duke_energy_electric",
    match: { type: "contains", value: "duke energy" },
    canonical: "Duke Energy",
    intents: ["electric", "utilities"],
    primary_intent: "electric",
    confidence: "high",
    notes: "Electric utility",
  },
  {
    key: "dukeenergy_electric",
    match: { type: "contains", value: "dukeenergy" },
    canonical: "Duke Energy",
    intents: ["electric", "utilities"],
    primary_intent: "electric",
    confidence: "high",
    notes: "Electric utility",
  }
);

// Vehicle charging
UNIVERSAL_VENDOR_HINTS.push(
  {
    key: "tesla_vehicle_charging",
    match: { type: "regex", value: "\\btesla\\b|\\btesla\\s+moto\\b|\\bsupercharger\\b" },
    canonical: "Tesla",
    intents: ["gas_charging", "vehicle_expense"],
    primary_intent: "gas_charging",
    confidence: "high",
    notes: "Vehicle charging / fuel equivalent",
  },
  {
    key: "chargeonsite_vehicle_charging",
    match: { type: "contains", value: "chargeonsite" },
    canonical: "ChargeOnSite",
    intents: ["gas_charging", "vehicle_expense"],
    primary_intent: "gas_charging",
    confidence: "high",
    notes: "Tesla/EV charging service",
  }
);

// Credit card rewards / cash back
UNIVERSAL_VENDOR_HINTS.push(
  {
    key: "cash_back_rewards_income",
    match: { type: "regex", value: "\\bcash\\s*back\\b|\\bcashback\\b|\\b(?:automatic\\s+)?statement\\s+credit\\b|\\brewards?\\s+credit\\b" },
    canonical: "Cash Back Rewards",
    intents: ["other_income"],
    primary_intent: "other_income",
    confidence: "medium",
    notes: "Likely credit-card rewards or cashback income",
  }
);

// Software / SaaS / productivity
addVendors(
  [
    "Microsoft",
    "Office 365",
    "Azure",
    "Amazon Web Services",
    "AWS",
    "Google Workspace",
    "Workspace",
    "Google Cloud",
    "GCP",
    "Alphabet",
    "Meta",
    "Facebook Ads",
    "Instagram Ads",
    "LinkedIn",
    "LinkedIn Ads",
    "Salesforce",
    "HubSpot",
    "Mailchimp",
    "SendGrid",
    "Twilio",
    "Stripe",
    "Square",
    "PayPal",
    "Shopify",
    "Klaviyo",
    "Segment",
    "Mixpanel",
    "Amplitude",
    "Datadog",
    "New Relic",
    "Sentry",
    "Rollbar",
    "Figma",
    "Instantly",
    "Atlassian",
    "Adobe",
    "Adobe Creative Cloud",
    "Apple",
    "Apple.com/Bill",
    "OpenAI",
    "ChatGPT",
    "Paramount+",
    "Paramount Plus",
    "YouTubeTV",
    "YouTube TV",
    "Spotify",
    "Railway",
    "Supabase",
    "Canva",
    "Notion",
    "Asana",
    "Trello",
    "Jira",
    "Confluence",
    "Slack",
    "Dropbox",
    "Box",
    "Zoom",
    "Loom",
    "Calendly",
    "Miro",
    "Lucidchart",
    "DocuSign",
    "HelloSign",
    "PandaDoc",
    "QuickBooks",
    "Intuit",
    "Xero",
    "Gusto",
    "ADP",
    "Rippling",
    "BambooHR",
    "Paychex",
    "Zenefits",
    "FreshBooks",
    "Expensify",
    "Bill.com",
    "Airbase",
    "Brex",
    "Ramp",
    "Navan",
    "TravelPerk",
  ],
  {
    intents: ["software", "subscriptions"],
    primary: "software",
    confidence: "medium",
    notes: "SaaS / tools",
  }
);

// Entertainment / tickets / recreation
addVendors(
  ["AMC", "AMC Theatres", "AMC Theaters", "Prime Video", "PlayStation", "Playstation Network", "Sony PlayStation", "Ticketmaster", "Fandango", "Gametime", "Rebill Gametime", "Monster Mini Golf"],
  { intents: ["entertainment"], primary: "entertainment", confidence: "medium", notes: "Entertainment, tickets, or recreation" }
);

// Clothing / apparel
addVendors(
  ["Nordstrom", "Dillards", "Dillard's"],
  { intents: ["clothing"], primary: "clothing", confidence: "medium", notes: "Clothing / apparel" }
);

// Marketing / ads / marketplaces
addVendors(
  [
    "Google Ads",
    "Meta Ads",
    "Facebook",
    "Instagram",
    "TikTok",
    "Snapchat",
    "Reddit Ads",
    "Twitter Ads",
    "X Ads",
    "Spotify Ads",
    "Yelp",
    "Angi",
    "HomeAdvisor",
    "Thumbtack",
    "Houzz",
    "Nextdoor",
    "Yelp Ads",
    "Bing Ads",
  ],
  { intents: ["marketing", "ads"], primary: "marketing", confidence: "high" }
);

// Payroll / HR / benefits (beyond SaaS list)
addVendors(
  ["Gusto Payroll", "ADP Payroll", "Paychex Payroll", "Justworks", "TriNet", "Insperity", "Sequoia", "Zenefits Payroll"],
  { intents: ["payroll"], primary: "payroll", confidence: "high" }
);

// Insurance
addVendors(
  [
    "Progressive",
    "Geico",
    "State Farm",
    "Allstate",
    "Nationwide",
    "Farmers Insurance",
    "Liberty Mutual",
    "Travelers Insurance",
    "The Hartford",
    "Chubb",
    "AIG",
    "Berkshire Hathaway Guard",
    "Next Insurance",
    "Embroker",
  ],
  { intents: ["insurance"], primary: "insurance", confidence: "high" }
);

// Telecom / utilities
addVendors(
  [
    "AT&T",
    "Verizon",
    "T-Mobile",
    "Sprint",
    "Comcast",
    "Xfinity",
    "Spectrum",
    "Charter",
    "Cox",
    "Frontier",
    "CenturyLink",
    "Lumen",
    "Windstream",
    "RCN",
    "Astound Broadband",
    "Google Fiber",
    "PG&E",
    "Con Edison",
    "Duke Energy",
    "National Grid",
    "Southern Company",
    "Dominion Energy",
    "Eversource",
    "LADWP",
  ],
  { intents: ["utilities", "telecom"], primary: "utilities", confidence: "medium" }
);

// Equipment rental / storage
addVendors(
  [
    "United Rentals",
    "Sunbelt Rentals",
    "Herc Rentals",
    "Ahern Rentals",
    "EquipmentShare",
    "BigRentz",
    "Home Depot Rental",
    "Lowe's Rental",
    "RentalMax",
    "BlueLine Rental",
    "CAT Rental Store",
    "Caterpillar Rental",
    "United Site Services",
    "WillScot",
    "Mobile Mini",
    "PODS",
    "U-Haul",
    "Penske Truck Rental",
    "Ryder",
    "Enterprise Truck Rental",
    "Budget Truck Rental",
    "Public Storage",
    "Extra Space Storage",
    "CubeSmart",
    "Life Storage",
  ],
  { intents: ["equipment_rental"], primary: "equipment_rental", confidence: "high", notes: "Equipment / truck / jobsite rental" }
);

// Subcontractors
UNIVERSAL_VENDOR_HINTS.push(
  {
    key: "subcontractor_trade_company_suffix",
    match: { type: "regex", value: "\\b(?:construction|electric|electrical|plumbing|hvac|roofing|concrete|painting|drywall|landscaping|landscape|masonry|excavating|excavation|flooring|framing|carpentry|paving|asphalt|septic|demolition|demo|insulation|glass|garage door|fencing|welding|mechanical)\\b.*\\b(?:llc|inc|co|company|corp|corporation|services|contractors|contracting)\\b" },
    canonical: "Subcontractor Trade Company",
    intents: ["subcontractors"],
    primary_intent: "subcontractors",
    confidence: "medium",
    notes: "Trade-company name pattern; confirm before posting",
  },
  {
    key: "subcontractor_trade_company_prefix",
    match: { type: "regex", value: "\\b(?:llc|inc|co|company|corp|corporation)\\b.*\\b(?:construction|electric|electrical|plumbing|hvac|roofing|concrete|painting|drywall|landscaping|landscape|masonry|excavating|excavation|flooring|framing|carpentry|paving|asphalt|septic|demolition|demo|insulation|glass|garage door|fencing|welding|mechanical)\\b" },
    canonical: "Subcontractor Trade Company",
    intents: ["subcontractors"],
    primary_intent: "subcontractors",
    confidence: "medium",
    notes: "Trade-company name pattern; confirm before posting",
  }
);

// Permits / licenses / municipal fees
UNIVERSAL_VENDOR_HINTS.push(
  {
    key: "permit_center",
    match: { type: "contains", value: "permit center" },
    canonical: "Permit Center",
    intents: ["permits_fees"],
    primary_intent: "permits_fees",
    confidence: "high",
    notes: "Permit / municipal fee",
  },
  {
    key: "building_department",
    match: { type: "contains", value: "building department" },
    canonical: "Building Department",
    intents: ["permits_fees"],
    primary_intent: "permits_fees",
    confidence: "high",
    notes: "Permit / inspection fee",
  },
  {
    key: "inspection_services",
    match: { type: "contains", value: "inspection services" },
    canonical: "Inspection Services",
    intents: ["permits_fees"],
    primary_intent: "permits_fees",
    confidence: "medium",
    notes: "Inspection / permit-related fee",
  },
  {
    key: "contractor_licensing",
    match: { type: "contains", value: "contractor licensing" },
    canonical: "Contractor Licensing",
    intents: ["permits_fees"],
    primary_intent: "permits_fees",
    confidence: "high",
    notes: "Contractor license / registration fee",
  },
  {
    key: "building_permit_regex",
    match: { type: "regex", value: "\\b(?:city of|county of|township of|department of buildings|building dept|dob|state licensing board|secretary of state|filings?\\s+[a-z]{2}\\s+secretary|secretary\\s+of\\s+state)\\b" },
    canonical: "Municipal / Licensing Agency",
    intents: ["business_licensing_fees", "permits_fees"],
    primary_intent: "business_licensing_fees",
    confidence: "medium",
    notes: "Municipal, permit, registration, or licensing fee",
  }
);

// Waste disposal / dump fees
addVendors(
  [
    "Waste Management",
    "Republic Services",
    "Waste Connections",
    "GFL Environmental",
    "Rumpke",
    "Recology",
    "Casella Waste",
    "Advanced Disposal",
    "1-800-GOT-JUNK",
    "Bagster",
    "Junk King",
    "College Hunks Hauling Junk",
  ],
  { intents: ["waste_disposal"], primary: "waste_disposal", confidence: "high", notes: "Waste disposal / hauling / dump fees" }
);

UNIVERSAL_VENDOR_HINTS.push(
  {
    key: "wm_waste_management",
    match: { type: "exact", value: "wm" },
    canonical: "WM",
    intents: ["waste_disposal"],
    primary_intent: "waste_disposal",
    confidence: "high",
    notes: "Waste Management / dump fees",
  },
  {
    key: "landfill_transfer_station",
    match: { type: "regex", value: "\\b(?:landfill|transfer station|dump fee|disposal fee)\\b" },
    canonical: "Landfill / Transfer Station",
    intents: ["waste_disposal"],
    primary_intent: "waste_disposal",
    confidence: "medium",
    notes: "Waste disposal / dump fee signal",
  }
);

// Uniforms / laundry
addVendors(
  [
    "Cintas",
    "UniFirst",
    "Aramark",
    "Alsco",
    "Prudential Overall Supply",
    "Vestis",
    "Red Kap",
    "Carhartt",
    "Work World",
    "Boot Barn",
  ],
  { intents: ["uniforms_laundry"], primary: "uniforms_laundry", confidence: "high", notes: "Uniforms / laundry / workwear" }
);

// Safety / PPE
addVendors(
  [
    "SafetyCompany",
    "Magid Glove",
    "Full Source",
    "Radians",
    "Mallory Safety",
    "PK Safety",
    "Grainger Safety",
    "Uline Safety",
    "Fastenal Safety",
    "MSC Safety",
    "Zoro Safety",
  ],
  { intents: ["safety_ppe"], primary: "safety_ppe", confidence: "high", notes: "Safety gear / PPE" }
);

// Food wholesalers / grocery bulk
addVendors(
  ["Restaurant Depot", "Sysco", "US Foods", "Gordon Food Service", "PFG", "Chefs' Warehouse"],
  { intents: ["food_supplies"], primary: "food_supplies", confidence: "high" }
);

// Banking / merchant fees signals (regex / contains)
UNIVERSAL_VENDOR_HINTS.push(
  {
    key: "bank_fee_monthly",
    match: { type: "contains", value: "monthly fee" },
    canonical: "Monthly Bank Fee",
    intents: ["bank_fees"],
    primary_intent: "bank_fees",
    confidence: "medium",
    notes: "Bank service fee",
  },
  {
    key: "bank_fee_service",
    match: { type: "contains", value: "service fee" },
    canonical: "Service Fee",
    intents: ["bank_fees"],
    primary_intent: "bank_fees",
    confidence: "medium",
  },
  {
    key: "bank_fee_interest",
    match: { type: "contains", value: "interest charge" },
    canonical: "Interest Charge",
    intents: ["interest_expense"],
    primary_intent: "interest_expense",
    confidence: "medium",
  },
  {
    key: "bank_fee_int",
    match: { type: "regex", value: "\\bint\\s*rest\\b" },
    canonical: "Interest",
    intents: ["interest_expense"],
    primary_intent: "interest_expense",
    confidence: "low",
  }
);

// Medical / health
addVendors(
  ["Rite Aid", "Duane Reade", "Health Mart", "Kaiser", "UnitedHealthcare", "Blue Cross", "Cigna", "Humana"],
  { intents: ["medical"], primary: "medical", confidence: "medium" }
);

// Pharmacy / convenience supplies
addVendors(
  ["CVS", "CVS Pharmacy", "Walgreens", "Walgreens Pharmacy"],
  { intents: ["supplies"], primary: "supplies", confidence: "medium", notes: "Pharmacy retail commonly used for business supplies" }
);

// Education / training
addVendors(
  ["Udemy", "Coursera", "LinkedIn Learning", "Pluralsight", "Skillshare", "General Assembly", "Codecademy"],
  { intents: ["training"], primary: "training", confidence: "medium" }
);

// Security / monitoring
addVendors(
  ["ADT", "Brinks", "Vivint", "Ring", "SimpliSafe", "Frontpoint"],
  { intents: ["security"], primary: "security", confidence: "medium" }
);

// Cleaning / janitorial
addVendors(
  ["Servpro", "ServiceMaster", "Jani-King", "Coverall", "Jan-Pro"],
  { intents: ["cleaning"], primary: "cleaning", confidence: "medium" }
);

// Tolls / parking
addVendors(
  ["ParkMobile", "Park Mobile", "ParkMobile CDOT Pay", "CDOT Pay", "NC Quick Pass", "Quick Pass", "ParkWhiz", "LAZ Parking", "SP Plus", "Impark", "EZPass", "SunPass", "FasTrak", "PayByPhone"],
  { intents: ["parking_tolls"], primary: "parking_tolls", confidence: "high" }
);

UNIVERSAL_VENDOR_HINTS.push(
  {
    key: "parking_mobile_meter_payment",
    match: { type: "regex", value: "\\bpark\\s*mobile\\b|\\bparkmobile\\b|\\bcdot\\s+pay\\b|\\bparking\\b|\\bpark\\b|\\blot\\b" },
    canonical: "Parking",
    intents: ["parking_tolls"],
    primary_intent: "parking_tolls",
    confidence: "high",
    notes: "Parking or toll payment",
  }
);

// Restaurants local/fast casual more
addVendors(
  [
    "Bonefish Grill",
    "Carrabba's",
    "Maggiano's",
    "Yard House",
    "BJ's Restaurant",
    "Dave & Buster's",
    "Fogo de Chao",
    "Seasons 52",
    "Bahama Breeze",
    "Miller's Ale House",
    "Twin Peaks",
    "Hooters",
    "Mission BBQ",
    "City Barbeque",
    "Famous Dave's",
    "Sonny's BBQ",
    "Portillo's",
    "Crumbl Cookies",
    "Nothing Bundt Cakes",
  ],
  { intents: ["meals"], primary: "meals", confidence: "high" }
);

// Coffee / bakery extras
addVendors(
  ["Krispy Kreme", "Dunkin Donuts", "Tim Hortons Coffee", "Blue Bottle Coffee", "Philz Coffee"],
  { intents: ["meals"], primary: "meals", confidence: "high" }
);

// Home services marketplaces
addVendors(
  ["Angi Leads", "HomeAdvisor Leads", "Thumbtack Leads", "Yelp Leads", "Porch", "TaskRabbit", "Handy", "Home Depot Pro Referral"],
  { intents: ["marketing", "leads"], primary: "marketing", confidence: "medium" }
);

// Vehicle leasing / fleet
addVendors(
  ["Enterprise Fleet", "ARI Fleet", "Wheels Donlen", "Element Fleet", "Holman Fleet"],
  { intents: ["vehicle_lease"], primary: "vehicle_lease", confidence: "medium" }
);

// Construction marketplaces / job mgmt
addVendors(
  ["Procore", "Buildertrend", "CoConstruct", "Fieldwire", "PlanGrid", "Bluebeam", "Autodesk Construction Cloud", "Jobber", "ServiceTitan", "Housecall Pro"],
  { intents: ["software"], primary: "software", confidence: "medium" }
);

// Banking / processors extras
addVendors(
  ["Stripe Fees", "Square Fees", "Shopify Payments", "Clover Payments", "Toast POS", "Lightspeed", "Revel Systems"],
  { intents: ["payment_processing"], primary: "payment_processing", confidence: "medium" }
);

// Vehicles / heavy equipment manufacturers (service/parts)
addVendors(
  ["Ford Motor", "GM Financial", "Chevrolet", "Ram Trucks", "Peterbilt", "Kenworth", "Volvo Trucks", "Mack Trucks", "PACCAR", "Isuzu Trucks"],
  { intents: ["vehicle_expense"], primary: "vehicle_expense", confidence: "low", notes: "Vehicle related; confirm context" }
);

// Vehicle maintenance / parts / tires
addVendors(
  [
    "NAPA Auto Parts",
    "AutoZone",
    "O'Reilly Auto Parts",
    "Advance Auto Parts",
    "Carquest",
    "Pep Boys",
    "Les Schwab",
    "Discount Tire",
    "Tire Kingdom",
    "Firestone Complete Auto Care",
    "Jiffy Lube",
    "Valvoline Instant Oil Change",
    "Valvoline",
    "Take 5 Oil Change",
    "Meineke",
    "Midas",
    "Monro Auto Service",
    "Mr. Tire",
    "Big O Tires",
    "Goodyear Auto Service",
    "Goodyear",
    "Tire Discounters",
    "Belle Tire",
    "America's Tire",
    "NTB",
    "National Tire and Battery",
    "Mavis Discount Tire",
    "Tires Plus",
    "AAMCO",
    "Christian Brothers Automotive",
    "Grease Monkey",
    "Express Oil Change",
    "SpeeDee Oil Change",
    "Quick Lane",
    "Meineke Car Care Center",
    "Jiffy Lube Multicare",
    "Safelite AutoGlass",
    "Maaco",
    "Caliber Collision",
    "Gerber Collision",
    "Crash Champions",
    "Service King",
    "FleetPride",
    "TruckPro",
    "TA Truck Service",
    "Love's Truck Care",
    "Pilot Flying J Truck Care",
    "Speedco",
    "Boss Truck Shops",
    "Goodyear Commercial Tire",
    "Bridgestone Commercial",
    "Michelin Retread",
  ],
  { intents: ["vehicle_expense"], primary: "vehicle_expense", confidence: "high", notes: "Vehicle maintenance / parts / tires" }
);

// Food delivery / catering
addVendors(
  ["DoorDash", "Uber Eats", "Grubhub", "Postmates", "Caviar"],
  { intents: ["meals"], primary: "meals", confidence: "medium" }
);

// Bank interest income detection (positive)
UNIVERSAL_VENDOR_HINTS.push({
  key: "bank_interest_income",
  match: { type: "contains", value: "interest income" },
  canonical: "Interest Income",
  intents: ["interest_income"],
  primary_intent: "interest_income",
  confidence: "medium",
});

// Debug helper (dev only)
export function debugUniversalHintExamples() {
  if (process.env.NODE_ENV === "production") return;
  const samples = [
    "Uber Trip 1234",
    "LYFT RIDE",
    "HOME DEPOT #123",
    "LOWE'S STORE",
    "GRAINGER INDUSTRIAL",
    "UNITED RENTALS",
    "SUNBELT RENTALS",
    "SHELL OIL",
    "PILOT TRAVEL CENTER",
    "MARRIOTT HOTEL",
    "DELTA AIR LINES",
    "STARBUCKS COFFEE",
    "MCDONALD'S",
    "AMAZON MARKETPLACE",
    "MICROSOFT 365",
    "GOOGLE ADS",
    "FACEBOOK ADS",
    "YELP ADS",
    "GUSTO PAYROLL",
    "ADP PAYROLL",
    "PROGRESSIVE INS",
    "VERIZON WIRELESS",
    "COMCAST BUSINESS",
    "FEDEX SHIP",
    "UPS",
    "USPS",
    "SQUARE *SPACE",
    "PAYPAL *STRIPE",
    "INT REST CHARGE",
  ];
  // Lazy import to avoid cycle
  import("./universalVendorHintMatcher.js").then(({ getUniversalVendorHintForTransaction }) => {
    samples.forEach((name) => {
      const hint = getUniversalVendorHintForTransaction({ bankTxn: { name } });
      console.info("[universalHint][sample]", name, "=>", hint);
    });
  });
}

export { UNIVERSAL_VENDOR_HINTS };

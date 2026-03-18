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
    "Pilot Travel Center",
    "Flying J",
    "Love's Travel Stop",
    "QuikTrip",
    "Wawa",
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
addVendors(["Uber", "Lyft", "Via"], {
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
  ["Amazon", "Amazon Marketplace", "Walmart", "Target", "Costco", "Sam's Club", "BJ's Wholesale", "Kroger", "Safeway", "Albertsons", "Publix", "Meijer", "H-E-B", "Aldi", "Lidl", "Trader Joe's"],
  { intents: ["general_supplies"], primary: "general_supplies", confidence: "medium" }
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
    "CAT Rental Store",
    "Herc Rentals",
    "United Rentals",
    "Sunbelt Rentals",
    "Ahern Rentals",
    "BlueLine Rental",
    "United Site Services",
    "EquipmentShare",
    "Tractor Supply",
    "Rural King",
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
  ],
  { intents: ["meals"], primary: "meals", confidence: "medium" }
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
    "Adobe",
    "Adobe Creative Cloud",
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

// Rentals / storage
addVendors(
  ["U-Haul", "Penske Truck Rental", "Ryder", "Enterprise Truck Rental", "Public Storage", "Extra Space Storage", "CubeSmart", "Life Storage"],
  { intents: ["rentals"], primary: "rentals", confidence: "medium" }
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
  ["CVS", "Walgreens", "Rite Aid", "Duane Reade", "Health Mart", "Kaiser", "UnitedHealthcare", "Blue Cross", "Cigna", "Humana", "Walgreens Pharmacy"],
  { intents: ["medical"], primary: "medical", confidence: "medium" }
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
  ["ParkMobile", "ParkWhiz", "LAZ Parking", "SP Plus", "Impark", "EZPass", "SunPass", "FasTrak", "PayByPhone"],
  { intents: ["parking_tolls"], primary: "parking_tolls", confidence: "medium" }
);

// Restaurants local/fast casual more
addVendors(
  ["IHOP", "Denny's", "Waffle House", "Cracker Barrel", "Red Robin", "Chili's", "Applebee's", "Texas Roadhouse", "Outback Steakhouse", "Red Lobster"],
  { intents: ["meals"], primary: "meals", confidence: "medium" }
);

// Coffee / bakery extras
addVendors(
  ["Krispy Kreme", "Dunkin Donuts", "Tim Hortons Coffee", "Blue Bottle Coffee", "Philz Coffee"],
  { intents: ["meals"], primary: "meals", confidence: "medium" }
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
  { intents: ["software", "construction_ops"], primary: "construction_ops", confidence: "medium" }
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

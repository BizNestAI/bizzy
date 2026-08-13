# biznest-app

Your AI business brain for home service business owners and construction business founders.

## Local Development

This app uses React, Vite, and a Node/Express backend. Keep private provider credentials and service-role keys in backend deployment environment variables only.

Browser-safe Vite variables must use the `VITE_` prefix and should be limited to public configuration such as the Supabase URL, Supabase anon key, and backend API base URL.

Never put OpenAI, Plaid, QuickBooks, Stripe, Supabase service-role, Resend, Google client secrets, provider refresh/access tokens, or encryption keys in `VITE_` variables.

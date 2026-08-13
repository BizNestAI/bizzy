# Supabase Two-Tenant Runtime Security Test

Executed: 2026-08-10T01:12:46.707Z
Run ID: `rls_1786324322655_e4591093`
Project ref: `cpkc...xrge`
Verdict: **PASS — TWO-TENANT ISOLATION VERIFIED**

No JWTs, API keys, service-role credentials, access tokens, or refresh tokens are included in this report.

## Summary

- Total tests: 570
- Passed: 570
- Failed: 0

## Matrix

| Surface | User A -> A | User A -> B | User B -> B | User B -> A | Anonymous |
| --- | --- | --- | --- | --- | --- |
| user_profiles | PASS | n/a | PASS | n/a | PASS |
| business_profiles | PASS | PASS | PASS | PASS | PASS |
| user_business_link | PASS | PASS | PASS | PASS | PASS |
| representative financial tables | PASS | PASS | PASS | PASS | n/a |
| credential tables | PASS | PASS | PASS | PASS | n/a |
| remaining uncertified tables | PASS | PASS | PASS | PASS | PASS |
| views and RPCs | PASS | PASS | PASS | PASS | PASS |

## Failed Tests

None.

## All Test Results

| Status | Table | Operation | Actor | Target | Expected | Actual |
| --- | --- | --- | --- | --- | --- | --- |
| PASS | user_profiles | SELECT | User A | own user | allowed rows | 1 row(s) |
| PASS | user_profiles | SELECT | User A | other user | denied/no rows | 0 row(s) |
| PASS | business_profiles | SELECT | User A | own business | allowed rows | 1 row(s) |
| PASS | business_profiles | SELECT | User A | Business B | denied/no rows | 0 row(s) |
| PASS | business_profiles | UPDATE | User A | Business B | denied/no mutation | 0 row(s) updated |
| PASS | business_profiles | UPDATE | User A | own business -> other owner | denied/no mutation | error 23000: BUSINESS_PROFILE_OWNER_IMMUTABLE |
| PASS | user_business_link | INSERT | User A | Business B | denied insert | error 42501: permission denied for table user_business_link |
| PASS | user_business_link | INSERT | User A | own business | denied insert | error 42501: permission denied for table user_business_link |
| PASS | user_business_link | UPDATE | User A | Business B | denied/no mutation | error 42501: permission denied for table user_business_link |
| PASS | user_business_link | DELETE | User A | Business B | denied/no mutation | error 42501: permission denied for table user_business_link |
| PASS | user_profiles | SELECT | User B | own user | allowed rows | 1 row(s) |
| PASS | user_profiles | SELECT | User B | other user | denied/no rows | 0 row(s) |
| PASS | business_profiles | SELECT | User B | own business | allowed rows | 1 row(s) |
| PASS | business_profiles | SELECT | User B | Business A | denied/no rows | 0 row(s) |
| PASS | business_profiles | UPDATE | User B | Business A | denied/no mutation | 0 row(s) updated |
| PASS | business_profiles | UPDATE | User B | own business -> other owner | denied/no mutation | error 23000: BUSINESS_PROFILE_OWNER_IMMUTABLE |
| PASS | user_business_link | INSERT | User B | Business A | denied insert | error 42501: permission denied for table user_business_link |
| PASS | user_business_link | INSERT | User B | own business | denied insert | error 42501: permission denied for table user_business_link |
| PASS | user_business_link | UPDATE | User B | Business A | denied/no mutation | error 42501: permission denied for table user_business_link |
| PASS | user_business_link | DELETE | User B | Business A | denied/no mutation | error 42501: permission denied for table user_business_link |
| PASS | user_profiles | SELECT | Anonymous | private user | denied/no rows | 0 row(s) |
| PASS | business_profiles | SELECT | Anonymous | private business | denied/no rows | error 42501: permission denied for table business_profiles |
| PASS | user_business_link | SELECT | Anonymous | private membership | denied/no rows | error 42501: permission denied for table user_business_link |
| PASS | business_profiles | INSERT | Anonymous | private business | denied insert | error 42501: permission denied for table business_profiles |
| PASS | bank_transactions | SELECT | User A | own tenant | allowed rows | 1 row(s) |
| PASS | bank_transactions | SELECT | User A | Business B | denied/no rows | 0 row(s) |
| PASS | bank_transactions | INSERT | User A | Business B | denied insert | error 42501: permission denied for table bank_transactions |
| PASS | bank_transactions | UPDATE | User A | Business B | denied/no mutation | error 42501: permission denied for table bank_transactions |
| PASS | bank_transactions | DELETE | User A | Business B | denied/no mutation | error 42501: permission denied for table bank_transactions |
| PASS | ar_open_items | SELECT | User A | own tenant | allowed rows | 1 row(s) |
| PASS | ar_open_items | SELECT | User A | Business B | denied/no rows | 0 row(s) |
| PASS | ar_open_items | INSERT | User A | Business B | denied insert | error 42501: permission denied for table ar_open_items |
| PASS | ar_open_items | UPDATE | User A | Business B | denied/no mutation | error 42501: permission denied for table ar_open_items |
| PASS | ar_open_items | DELETE | User A | Business B | denied/no mutation | error 42501: permission denied for table ar_open_items |
| PASS | invoices | SELECT | User A | own tenant | allowed rows | 1 row(s) |
| PASS | invoices | SELECT | User A | Business B | denied/no rows | 0 row(s) |
| PASS | invoices | INSERT | User A | Business B | denied insert | error 42501: permission denied for table invoices |
| PASS | invoices | UPDATE | User A | Business B | denied/no mutation | error 42501: permission denied for table invoices |
| PASS | invoices | DELETE | User A | Business B | denied/no mutation | error 42501: permission denied for table invoices |
| PASS | financial_metrics | SELECT | User A | own tenant | allowed rows | 1 row(s) |
| PASS | financial_metrics | SELECT | User A | Business B | denied/no rows | 0 row(s) |
| PASS | financial_metrics | INSERT | User A | Business B | denied insert | error 42501: permission denied for table financial_metrics |
| PASS | financial_metrics | UPDATE | User A | Business B | denied/no mutation | error 42501: permission denied for table financial_metrics |
| PASS | financial_metrics | DELETE | User A | Business B | denied/no mutation | error 42501: permission denied for table financial_metrics |
| PASS | tax_snapshots | SELECT | User A | own tenant | allowed rows | 1 row(s) |
| PASS | tax_snapshots | SELECT | User A | Business B | denied/no rows | 0 row(s) |
| PASS | tax_snapshots | INSERT | User A | Business B | denied insert | error 42501: permission denied for table tax_snapshots |
| PASS | tax_snapshots | UPDATE | User A | Business B | denied/no mutation | error 42501: permission denied for table tax_snapshots |
| PASS | tax_snapshots | DELETE | User A | Business B | denied/no mutation | error 42501: permission denied for table tax_snapshots |
| PASS | bizzy_memory | SELECT | User A | own tenant | allowed rows | 1 row(s) |
| PASS | bizzy_memory | SELECT | User A | Business B | denied/no rows | 0 row(s) |
| PASS | bizzy_memory | INSERT | User A | Business B | denied insert | error 42501: permission denied for table bizzy_memory |
| PASS | bizzy_memory | UPDATE | User A | Business B | denied/no mutation | error 42501: permission denied for table bizzy_memory |
| PASS | bizzy_memory | DELETE | User A | Business B | denied/no mutation | error 42501: permission denied for table bizzy_memory |
| PASS | gpt_usage | SELECT | User A | own tenant | allowed rows | 1 row(s) |
| PASS | gpt_usage | SELECT | User A | Business B | denied/no rows | 0 row(s) |
| PASS | gpt_usage | INSERT | User A | Business B | denied insert | error 42501: permission denied for table gpt_usage |
| PASS | gpt_usage | UPDATE | User A | Business B | denied/no mutation | error 42501: permission denied for table gpt_usage |
| PASS | bank_transactions | SELECT | User B | own tenant | allowed rows | 1 row(s) |
| PASS | bank_transactions | SELECT | User B | Business A | denied/no rows | 0 row(s) |
| PASS | bank_transactions | INSERT | User B | Business A | denied insert | error 42501: permission denied for table bank_transactions |
| PASS | bank_transactions | UPDATE | User B | Business A | denied/no mutation | error 42501: permission denied for table bank_transactions |
| PASS | bank_transactions | DELETE | User B | Business A | denied/no mutation | error 42501: permission denied for table bank_transactions |
| PASS | ar_open_items | SELECT | User B | own tenant | allowed rows | 1 row(s) |
| PASS | ar_open_items | SELECT | User B | Business A | denied/no rows | 0 row(s) |
| PASS | ar_open_items | INSERT | User B | Business A | denied insert | error 42501: permission denied for table ar_open_items |
| PASS | ar_open_items | UPDATE | User B | Business A | denied/no mutation | error 42501: permission denied for table ar_open_items |
| PASS | ar_open_items | DELETE | User B | Business A | denied/no mutation | error 42501: permission denied for table ar_open_items |
| PASS | invoices | SELECT | User B | own tenant | allowed rows | 1 row(s) |
| PASS | invoices | SELECT | User B | Business A | denied/no rows | 0 row(s) |
| PASS | invoices | INSERT | User B | Business A | denied insert | error 42501: permission denied for table invoices |
| PASS | invoices | UPDATE | User B | Business A | denied/no mutation | error 42501: permission denied for table invoices |
| PASS | invoices | DELETE | User B | Business A | denied/no mutation | error 42501: permission denied for table invoices |
| PASS | financial_metrics | SELECT | User B | own tenant | allowed rows | 1 row(s) |
| PASS | financial_metrics | SELECT | User B | Business A | denied/no rows | 0 row(s) |
| PASS | financial_metrics | INSERT | User B | Business A | denied insert | error 42501: permission denied for table financial_metrics |
| PASS | financial_metrics | UPDATE | User B | Business A | denied/no mutation | error 42501: permission denied for table financial_metrics |
| PASS | financial_metrics | DELETE | User B | Business A | denied/no mutation | error 42501: permission denied for table financial_metrics |
| PASS | tax_snapshots | SELECT | User B | own tenant | allowed rows | 1 row(s) |
| PASS | tax_snapshots | SELECT | User B | Business A | denied/no rows | 0 row(s) |
| PASS | tax_snapshots | INSERT | User B | Business A | denied insert | error 42501: permission denied for table tax_snapshots |
| PASS | tax_snapshots | UPDATE | User B | Business A | denied/no mutation | error 42501: permission denied for table tax_snapshots |
| PASS | tax_snapshots | DELETE | User B | Business A | denied/no mutation | error 42501: permission denied for table tax_snapshots |
| PASS | bizzy_memory | SELECT | User B | own tenant | allowed rows | 1 row(s) |
| PASS | bizzy_memory | SELECT | User B | Business A | denied/no rows | 0 row(s) |
| PASS | bizzy_memory | INSERT | User B | Business A | denied insert | error 42501: permission denied for table bizzy_memory |
| PASS | bizzy_memory | UPDATE | User B | Business A | denied/no mutation | error 42501: permission denied for table bizzy_memory |
| PASS | bizzy_memory | DELETE | User B | Business A | denied/no mutation | error 42501: permission denied for table bizzy_memory |
| PASS | gpt_usage | SELECT | User B | own tenant | allowed rows | 1 row(s) |
| PASS | gpt_usage | SELECT | User B | Business A | denied/no rows | 0 row(s) |
| PASS | gpt_usage | INSERT | User B | Business A | denied insert | error 42501: permission denied for table gpt_usage |
| PASS | gpt_usage | UPDATE | User B | Business A | denied/no mutation | error 42501: permission denied for table gpt_usage |
| PASS | quickbooks_tokens | SELECT | User A | own tenant credential table | denied/no rows | error 42501: permission denied for table quickbooks_tokens |
| PASS | quickbooks_tokens | SELECT | User A | Business B | denied/no rows | error 42501: permission denied for table quickbooks_tokens |
| PASS | quickbooks_tokens | INSERT | User A | Business B | denied insert | error 42501: permission denied for table quickbooks_tokens |
| PASS | quickbooks_tokens | UPDATE | User A | Business B | denied/no mutation | error 42501: permission denied for table quickbooks_tokens |
| PASS | quickbooks_tokens | DELETE | User A | Business B | denied/no mutation | error 42501: permission denied for table quickbooks_tokens |
| PASS | plaid_items | SELECT | User A | own tenant credential table | denied/no rows | error 42501: permission denied for table plaid_items |
| PASS | plaid_items | SELECT | User A | Business B | denied/no rows | error 42501: permission denied for table plaid_items |
| PASS | plaid_items | INSERT | User A | Business B | denied insert | error 42501: permission denied for table plaid_items |
| PASS | plaid_items | UPDATE | User A | Business B | denied/no mutation | error 42501: permission denied for table plaid_items |
| PASS | plaid_items | DELETE | User A | Business B | denied/no mutation | error 42501: permission denied for table plaid_items |
| PASS | linked_financial_items | SELECT | User A | own tenant credential table | denied/no rows | error 42501: permission denied for table linked_financial_items |
| PASS | linked_financial_items | SELECT | User A | Business B | denied/no rows | error 42501: permission denied for table linked_financial_items |
| PASS | linked_financial_items | INSERT | User A | Business B | denied insert | error 42501: permission denied for table linked_financial_items |
| PASS | linked_financial_items | UPDATE | User A | Business B | denied/no mutation | error 42501: permission denied for table linked_financial_items |
| PASS | linked_financial_items | DELETE | User A | Business B | denied/no mutation | error 42501: permission denied for table linked_financial_items |
| PASS | oauth_connection_states | SELECT | User A | own tenant credential table | denied/no rows | error 42501: permission denied for table oauth_connection_states |
| PASS | oauth_connection_states | SELECT | User A | Business B | denied/no rows | error 42501: permission denied for table oauth_connection_states |
| PASS | oauth_connection_states | INSERT | User A | Business B | denied insert | error 42501: permission denied for table oauth_connection_states |
| PASS | oauth_connection_states | UPDATE | User A | Business B | denied/no mutation | error 42501: permission denied for table oauth_connection_states |
| PASS | oauth_connection_states | DELETE | User A | Business B | denied/no mutation | error 42501: permission denied for table oauth_connection_states |
| PASS | email_accounts | SELECT | User A | own tenant credential table | denied/no rows | error 42501: permission denied for table email_accounts |
| PASS | email_accounts | SELECT | User A | Business B | denied/no rows | error 42501: permission denied for table email_accounts |
| PASS | email_accounts | INSERT | User A | Business B | denied insert | error 42501: permission denied for table email_accounts |
| PASS | email_accounts | UPDATE | User A | Business B | denied/no mutation | error 42501: permission denied for table email_accounts |
| PASS | email_accounts | DELETE | User A | Business B | denied/no mutation | error 42501: permission denied for table email_accounts |
| PASS | quickbooks_tokens | SELECT | User B | own tenant credential table | denied/no rows | error 42501: permission denied for table quickbooks_tokens |
| PASS | quickbooks_tokens | SELECT | User B | Business A | denied/no rows | error 42501: permission denied for table quickbooks_tokens |
| PASS | quickbooks_tokens | INSERT | User B | Business A | denied insert | error 42501: permission denied for table quickbooks_tokens |
| PASS | quickbooks_tokens | UPDATE | User B | Business A | denied/no mutation | error 42501: permission denied for table quickbooks_tokens |
| PASS | quickbooks_tokens | DELETE | User B | Business A | denied/no mutation | error 42501: permission denied for table quickbooks_tokens |
| PASS | plaid_items | SELECT | User B | own tenant credential table | denied/no rows | error 42501: permission denied for table plaid_items |
| PASS | plaid_items | SELECT | User B | Business A | denied/no rows | error 42501: permission denied for table plaid_items |
| PASS | plaid_items | INSERT | User B | Business A | denied insert | error 42501: permission denied for table plaid_items |
| PASS | plaid_items | UPDATE | User B | Business A | denied/no mutation | error 42501: permission denied for table plaid_items |
| PASS | plaid_items | DELETE | User B | Business A | denied/no mutation | error 42501: permission denied for table plaid_items |
| PASS | linked_financial_items | SELECT | User B | own tenant credential table | denied/no rows | error 42501: permission denied for table linked_financial_items |
| PASS | linked_financial_items | SELECT | User B | Business A | denied/no rows | error 42501: permission denied for table linked_financial_items |
| PASS | linked_financial_items | INSERT | User B | Business A | denied insert | error 42501: permission denied for table linked_financial_items |
| PASS | linked_financial_items | UPDATE | User B | Business A | denied/no mutation | error 42501: permission denied for table linked_financial_items |
| PASS | linked_financial_items | DELETE | User B | Business A | denied/no mutation | error 42501: permission denied for table linked_financial_items |
| PASS | oauth_connection_states | SELECT | User B | own tenant credential table | denied/no rows | error 42501: permission denied for table oauth_connection_states |
| PASS | oauth_connection_states | SELECT | User B | Business A | denied/no rows | error 42501: permission denied for table oauth_connection_states |
| PASS | oauth_connection_states | INSERT | User B | Business A | denied insert | error 42501: permission denied for table oauth_connection_states |
| PASS | oauth_connection_states | UPDATE | User B | Business A | denied/no mutation | error 42501: permission denied for table oauth_connection_states |
| PASS | oauth_connection_states | DELETE | User B | Business A | denied/no mutation | error 42501: permission denied for table oauth_connection_states |
| PASS | email_accounts | SELECT | User B | own tenant credential table | denied/no rows | error 42501: permission denied for table email_accounts |
| PASS | email_accounts | SELECT | User B | Business A | denied/no rows | error 42501: permission denied for table email_accounts |
| PASS | email_accounts | INSERT | User B | Business A | denied insert | error 42501: permission denied for table email_accounts |
| PASS | email_accounts | UPDATE | User B | Business A | denied/no mutation | error 42501: permission denied for table email_accounts |
| PASS | email_accounts | DELETE | User B | Business A | denied/no mutation | error 42501: permission denied for table email_accounts |
| PASS | account_breakdown | SELECT | User A | own server-only table | denied/no rows | error 42501: permission denied for table account_breakdown |
| PASS | account_breakdown | SELECT | User A | Business B | denied/no rows | error 42501: permission denied for table account_breakdown |
| PASS | account_breakdown | INSERT | User A | Business B | denied insert | error 42501: permission denied for table account_breakdown |
| PASS | account_breakdown | UPDATE | User A | Business B | denied/no mutation | error PGRST204: Could not find the 'updated_at' column of 'account_breakdown' in the schema cache |
| PASS | account_breakdown | DELETE | User A | Business B | denied/no mutation | error 42501: permission denied for table account_breakdown |
| PASS | affordability_assessments | SELECT | User A | own server-only table | denied/no rows | error 42501: permission denied for table affordability_assessments |
| PASS | affordability_assessments | SELECT | User A | Business B | denied/no rows | error 42501: permission denied for table affordability_assessments |
| PASS | affordability_assessments | INSERT | User A | Business B | denied insert | error 42501: permission denied for table affordability_assessments |
| PASS | affordability_assessments | UPDATE | User A | Business B | denied/no mutation | error PGRST204: Could not find the 'updated_at' column of 'affordability_assessments' in the schema cache |
| PASS | affordability_assessments | DELETE | User A | Business B | denied/no mutation | error 42501: permission denied for table affordability_assessments |
| PASS | balance_sheet_history | SELECT | User A | own server-only table | denied/no rows | error 42501: permission denied for table balance_sheet_history |
| PASS | balance_sheet_history | SELECT | User A | Business B | denied/no rows | error 42501: permission denied for table balance_sheet_history |
| PASS | balance_sheet_history | INSERT | User A | Business B | denied insert | error 42501: permission denied for table balance_sheet_history |
| PASS | balance_sheet_history | UPDATE | User A | Business B | denied/no mutation | error PGRST204: Could not find the 'updated_at' column of 'balance_sheet_history' in the schema cache |
| PASS | balance_sheet_history | DELETE | User A | Business B | denied/no mutation | error 42501: permission denied for table balance_sheet_history |
| PASS | billing_customers | SELECT | User A | own server-only table | denied/no rows | error 42501: permission denied for table billing_customers |
| PASS | billing_customers | SELECT | User A | Business B | denied/no rows | error 42501: permission denied for table billing_customers |
| PASS | billing_customers | INSERT | User A | Business B | denied insert | error 42501: permission denied for table billing_customers |
| PASS | billing_customers | UPDATE | User A | Business B | denied/no mutation | error PGRST204: Could not find the 'updated_at' column of 'billing_customers' in the schema cache |
| PASS | billing_customers | DELETE | User A | Business B | denied/no mutation | error 42501: permission denied for table billing_customers |
| PASS | bizzy_deadlines | SELECT | User A | own server-only table | denied/no rows | error 42501: permission denied for table bizzy_deadlines |
| PASS | bizzy_deadlines | SELECT | User A | Business B | denied/no rows | error 42501: permission denied for table bizzy_deadlines |
| PASS | bizzy_deadlines | INSERT | User A | Business B | denied insert | error 42501: permission denied for table bizzy_deadlines |
| PASS | bizzy_deadlines | UPDATE | User A | Business B | denied/no mutation | error 42501: permission denied for table bizzy_deadlines |
| PASS | bizzy_deadlines | DELETE | User A | Business B | denied/no mutation | error 42501: permission denied for table bizzy_deadlines |
| PASS | bizzy_headlines | SELECT | User A | own server-only table | denied/no rows | error 42501: permission denied for table bizzy_headlines |
| PASS | bizzy_headlines | SELECT | User A | Business B | denied/no rows | error 42501: permission denied for table bizzy_headlines |
| PASS | bizzy_headlines | INSERT | User A | Business B | denied insert | error 42501: permission denied for table bizzy_headlines |
| PASS | bizzy_headlines | UPDATE | User A | Business B | denied/no mutation | error PGRST204: Could not find the 'updated_at' column of 'bizzy_headlines' in the schema cache |
| PASS | bizzy_headlines | DELETE | User A | Business B | denied/no mutation | error 42501: permission denied for table bizzy_headlines |
| PASS | bookkeeping_health | SELECT | User A | own server-only table | denied/no rows | error 42501: permission denied for table bookkeeping_health |
| PASS | bookkeeping_health | SELECT | User A | Business B | denied/no rows | error 42501: permission denied for table bookkeeping_health |
| PASS | bookkeeping_health | INSERT | User A | Business B | denied insert | error 42501: permission denied for table bookkeeping_health |
| PASS | bookkeeping_health | UPDATE | User A | Business B | denied/no mutation | error 42501: permission denied for table bookkeeping_health |
| PASS | bookkeeping_health | DELETE | User A | Business B | denied/no mutation | error 42501: permission denied for table bookkeeping_health |
| PASS | calendar_events | SELECT | User A | own server-only table | denied/no rows | error 42501: permission denied for table calendar_events |
| PASS | calendar_events | SELECT | User A | Business B | denied/no rows | error 42501: permission denied for table calendar_events |
| PASS | calendar_events | INSERT | User A | Business B | denied insert | error 42501: permission denied for table calendar_events |
| PASS | calendar_events | UPDATE | User A | Business B | denied/no mutation | error 42501: permission denied for table calendar_events |
| PASS | calendar_events | DELETE | User A | Business B | denied/no mutation | error 42501: permission denied for table calendar_events |
| PASS | categorization_rules | SELECT | User A | own server-only table | denied/no rows | error 42501: permission denied for table categorization_rules |
| PASS | categorization_rules | SELECT | User A | Business B | denied/no rows | error 42501: permission denied for table categorization_rules |
| PASS | categorization_rules | INSERT | User A | Business B | denied insert | error 42501: permission denied for table categorization_rules |
| PASS | categorization_rules | UPDATE | User A | Business B | denied/no mutation | error 42501: permission denied for table categorization_rules |
| PASS | categorization_rules | DELETE | User A | Business B | denied/no mutation | error 42501: permission denied for table categorization_rules |
| PASS | gpt_messages_backup | SELECT | User A | own server-only table | denied/no rows | error 42501: permission denied for table gpt_messages_backup |
| PASS | gpt_messages_backup | SELECT | User A | Business B | denied/no rows | error 42501: permission denied for table gpt_messages_backup |
| PASS | gpt_messages_backup | INSERT | User A | Business B | denied insert | error 42501: permission denied for table gpt_messages_backup |
| PASS | gpt_messages_backup | UPDATE | User A | Business B | denied/no mutation | error PGRST204: Could not find the 'updated_at' column of 'gpt_messages_backup' in the schema cache |
| PASS | gpt_messages_backup | DELETE | User A | Business B | denied/no mutation | error 42501: permission denied for table gpt_messages_backup |
| PASS | insight_reads | SELECT | User A | own server-only table | denied/no rows | error 42501: permission denied for table insight_reads |
| PASS | insight_reads | SELECT | User A | Business B | denied/no rows | error 42501: permission denied for table insight_reads |
| PASS | insight_reads | INSERT | User A | Business B | denied insert | error 42501: permission denied for table insight_reads |
| PASS | insight_reads | UPDATE | User A | Business B | denied/no mutation | error PGRST204: Could not find the 'updated_at' column of 'insight_reads' in the schema cache |
| PASS | insight_reads | DELETE | User A | Business B | denied/no mutation | error 42501: permission denied for table insight_reads |
| PASS | integration_connections | SELECT | User A | own server-only table | denied/no rows | error 42501: permission denied for table integration_connections |
| PASS | integration_connections | SELECT | User A | Business B | denied/no rows | error 42501: permission denied for table integration_connections |
| PASS | integration_connections | INSERT | User A | Business B | denied insert | error 42501: permission denied for table integration_connections |
| PASS | integration_connections | UPDATE | User A | Business B | denied/no mutation | error 42501: permission denied for table integration_connections |
| PASS | integration_connections | DELETE | User A | Business B | denied/no mutation | error 42501: permission denied for table integration_connections |
| PASS | investment_accounts | SELECT | User A | own server-only table | denied/no rows | error 42501: permission denied for table investment_accounts |
| PASS | investment_accounts | SELECT | User A | Business B | denied/no rows | error 42501: permission denied for table investment_accounts |
| PASS | investment_accounts | INSERT | User A | Business B | denied insert | error 42501: permission denied for table investment_accounts |
| PASS | investment_accounts | UPDATE | User A | Business B | denied/no mutation | error PGRST204: Could not find the 'updated_at' column of 'investment_accounts' in the schema cache |
| PASS | investment_accounts | DELETE | User A | Business B | denied/no mutation | error 42501: permission denied for table investment_accounts |
| PASS | investment_balances | SELECT | User A | own server-only table | denied/no rows | error 42501: permission denied for table investment_balances |
| PASS | investment_balances | SELECT | User A | Business B | denied/no rows | error 42501: permission denied for table investment_balances |
| PASS | investment_balances | INSERT | User A | Business B | denied insert | error 42501: permission denied for table investment_balances |
| PASS | investment_balances | UPDATE | User A | Business B | denied/no mutation | error PGRST204: Could not find the 'updated_at' column of 'investment_balances' in the schema cache |
| PASS | investment_balances | DELETE | User A | Business B | denied/no mutation | error 42501: permission denied for table investment_balances |
| PASS | monthly_forecast | SELECT | User A | own server-only table | denied/no rows | error 42501: permission denied for table monthly_forecast |
| PASS | monthly_forecast | SELECT | User A | Business B | denied/no rows | error 42501: permission denied for table monthly_forecast |
| PASS | monthly_forecast | INSERT | User A | Business B | denied insert | error 42501: permission denied for table monthly_forecast |
| PASS | monthly_forecast | UPDATE | User A | Business B | denied/no mutation | error 42501: permission denied for table monthly_forecast |
| PASS | monthly_forecast | DELETE | User A | Business B | denied/no mutation | error 42501: permission denied for table monthly_forecast |
| PASS | plaid_accounts | SELECT | User A | own server-only table | denied/no rows | error 42501: permission denied for table plaid_accounts |
| PASS | plaid_accounts | SELECT | User A | Business B | denied/no rows | error 42501: permission denied for table plaid_accounts |
| PASS | plaid_accounts | INSERT | User A | Business B | denied insert | error 42501: permission denied for table plaid_accounts |
| PASS | plaid_accounts | UPDATE | User A | Business B | denied/no mutation | error 42501: permission denied for table plaid_accounts |
| PASS | plaid_accounts | DELETE | User A | Business B | denied/no mutation | error 42501: permission denied for table plaid_accounts |
| PASS | plaid_qbo_account_mappings | SELECT | User A | own server-only table | denied/no rows | error 42501: permission denied for table plaid_qbo_account_mappings |
| PASS | plaid_qbo_account_mappings | SELECT | User A | Business B | denied/no rows | error 42501: permission denied for table plaid_qbo_account_mappings |
| PASS | plaid_qbo_account_mappings | INSERT | User A | Business B | denied insert | error 42501: permission denied for table plaid_qbo_account_mappings |
| PASS | plaid_qbo_account_mappings | UPDATE | User A | Business B | denied/no mutation | error 42501: permission denied for table plaid_qbo_account_mappings |
| PASS | plaid_qbo_account_mappings | DELETE | User A | Business B | denied/no mutation | error 42501: permission denied for table plaid_qbo_account_mappings |
| PASS | positions | SELECT | User A | own server-only table | denied/no rows | error 42501: permission denied for table positions |
| PASS | positions | SELECT | User A | Business B | denied/no rows | error 42501: permission denied for table positions |
| PASS | positions | INSERT | User A | Business B | denied insert | error 42501: permission denied for table positions |
| PASS | positions | UPDATE | User A | Business B | denied/no mutation | error PGRST204: Could not find the 'updated_at' column of 'positions' in the schema cache |
| PASS | positions | DELETE | User A | Business B | denied/no mutation | error 42501: permission denied for table positions |
| PASS | qbo_posted_transactions | SELECT | User A | own server-only table | denied/no rows | error 42501: permission denied for table qbo_posted_transactions |
| PASS | qbo_posted_transactions | SELECT | User A | Business B | denied/no rows | error 42501: permission denied for table qbo_posted_transactions |
| PASS | qbo_posted_transactions | INSERT | User A | Business B | denied insert | error 42501: permission denied for table qbo_posted_transactions |
| PASS | qbo_posted_transactions | UPDATE | User A | Business B | denied/no mutation | error 42501: permission denied for table qbo_posted_transactions |
| PASS | qbo_posted_transactions | DELETE | User A | Business B | denied/no mutation | error 42501: permission denied for table qbo_posted_transactions |
| PASS | review_sources | SELECT | User A | own server-only table | denied/no rows | error 42501: permission denied for table review_sources |
| PASS | review_sources | SELECT | User A | Business B | denied/no rows | error 42501: permission denied for table review_sources |
| PASS | review_sources | INSERT | User A | Business B | denied insert | error 42501: permission denied for table review_sources |
| PASS | review_sources | UPDATE | User A | Business B | denied/no mutation | error PGRST204: Could not find the 'updated_at' column of 'review_sources' in the schema cache |
| PASS | review_sources | DELETE | User A | Business B | denied/no mutation | error 42501: permission denied for table review_sources |
| PASS | subscriptions | SELECT | User A | own server-only table | denied/no rows | error 42501: permission denied for table subscriptions |
| PASS | subscriptions | SELECT | User A | Business B | denied/no rows | error 42501: permission denied for table subscriptions |
| PASS | subscriptions | INSERT | User A | Business B | denied insert | error 42501: permission denied for table subscriptions |
| PASS | subscriptions | UPDATE | User A | Business B | denied/no mutation | error 42501: permission denied for table subscriptions |
| PASS | subscriptions | DELETE | User A | Business B | denied/no mutation | error 42501: permission denied for table subscriptions |
| PASS | transaction_categorizations | SELECT | User A | own server-only table | denied/no rows | error 42501: permission denied for table transaction_categorizations |
| PASS | transaction_categorizations | SELECT | User A | Business B | denied/no rows | error 42501: permission denied for table transaction_categorizations |
| PASS | transaction_categorizations | INSERT | User A | Business B | denied insert | error 42501: permission denied for table transaction_categorizations |
| PASS | transaction_categorizations | UPDATE | User A | Business B | denied/no mutation | error 42501: permission denied for table transaction_categorizations |
| PASS | transaction_categorizations | DELETE | User A | Business B | denied/no mutation | error 42501: permission denied for table transaction_categorizations |
| PASS | vendor_rules | SELECT | User A | own server-only table | denied/no rows | error 42501: permission denied for table vendor_rules |
| PASS | vendor_rules | SELECT | User A | Business B | denied/no rows | error 42501: permission denied for table vendor_rules |
| PASS | vendor_rules | INSERT | User A | Business B | denied insert | error 42501: permission denied for table vendor_rules |
| PASS | vendor_rules | UPDATE | User A | Business B | denied/no mutation | error 42501: permission denied for table vendor_rules |
| PASS | vendor_rules | DELETE | User A | Business B | denied/no mutation | error 42501: permission denied for table vendor_rules |
| PASS | cashflow_forecast | SELECT | User A | own server-only table | denied/no rows | error 42501: permission denied for table cashflow_forecast |
| PASS | cashflow_forecast | SELECT | User A | Business B | denied/no rows | error 42501: permission denied for table cashflow_forecast |
| PASS | cashflow_forecast | INSERT | User A | Business B | denied insert | error 42501: permission denied for table cashflow_forecast |
| PASS | cashflow_forecast | UPDATE | User A | Business B | denied/no mutation | error 42501: permission denied for table cashflow_forecast |
| PASS | cashflow_forecast | DELETE | User A | Business B | denied/no mutation | error 42501: permission denied for table cashflow_forecast |
| PASS | gpt_messages | SELECT | User A | own server-only table | denied/no rows | error 42501: permission denied for table gpt_messages |
| PASS | gpt_messages | SELECT | User A | Business B | denied/no rows | error 42501: permission denied for table gpt_messages |
| PASS | gpt_messages | INSERT | User A | Business B | denied insert | error 42501: permission denied for table gpt_messages |
| PASS | gpt_messages | UPDATE | User A | Business B | denied/no mutation | error PGRST204: Could not find the 'updated_at' column of 'gpt_messages' in the schema cache |
| PASS | gpt_messages | DELETE | User A | Business B | denied/no mutation | error 42501: permission denied for table gpt_messages |
| PASS | expense_totals_monthly | SELECT | User A | own tenant | allowed rows | 1 row(s) |
| PASS | expense_totals_monthly | SELECT | User A | Business B | denied/no rows | 0 row(s) |
| PASS | expense_totals_monthly | INSERT | User A | Business B | denied insert | error 42501: permission denied for table expense_totals_monthly |
| PASS | expense_totals_monthly | UPDATE | User A | Business B | denied/no mutation | error 42501: permission denied for table expense_totals_monthly |
| PASS | expense_totals_monthly | DELETE | User A | Business B | denied/no mutation | error 42501: permission denied for table expense_totals_monthly |
| PASS | insights | SELECT | User A | own tenant | allowed rows | 1 row(s) |
| PASS | insights | SELECT | User A | Business B | denied/no rows | 0 row(s) |
| PASS | insights | INSERT | User A | Business B | denied insert | error 42501: permission denied for table insights |
| PASS | insights | UPDATE | User A | Business B | denied/no mutation | error 42501: permission denied for table insights |
| PASS | insights | DELETE | User A | Business B | denied/no mutation | error 42501: permission denied for table insights |
| PASS | tax_deadlines | SELECT | User A | own tenant | allowed rows | 1 row(s) |
| PASS | tax_deadlines | SELECT | User A | Business B | denied/no rows | 0 row(s) |
| PASS | tax_deadlines | INSERT | User A | Business B | denied insert | error 42501: permission denied for table tax_deadlines |
| PASS | tax_deadlines | UPDATE | User A | Business B | denied/no mutation | error 42501: permission denied for table tax_deadlines |
| PASS | tax_deadlines | DELETE | User A | Business B | denied/no mutation | error 42501: permission denied for table tax_deadlines |
| PASS | notifications | SELECT | User A | own user | allowed rows | 1 row(s) |
| PASS | notifications | SELECT | User A | other user | denied/no rows | 0 row(s) |
| PASS | notifications | INSERT | User A | other user | denied insert | error 42501: new row violates row-level security policy for table "notifications" |
| PASS | notifications | UPDATE | User A | own user | allowed update | 1 row(s) updated |
| PASS | notifications | UPDATE | User A | other user | denied/no mutation | 0 row(s) updated |
| PASS | notifications | DELETE | User A | other user | denied/no mutation | error 42501: permission denied for table notifications |
| PASS | profiles | SELECT | User A | own user | allowed rows | 1 row(s) |
| PASS | profiles | SELECT | User A | other user | denied/no rows | 0 row(s) |
| PASS | profiles | INSERT | User A | other user | denied insert | error 42501: new row violates row-level security policy for table "profiles" |
| PASS | profiles | UPDATE | User A | own user | allowed update | 1 row(s) updated |
| PASS | profiles | UPDATE | User A | other user | denied/no mutation | 0 row(s) updated |
| PASS | profiles | DELETE | User A | other user | denied/no mutation | error 42501: permission denied for table profiles |
| PASS | insight_preferences | SELECT | User A | own user | allowed rows | 1 row(s) |
| PASS | insight_preferences | SELECT | User A | other user | denied/no rows | 0 row(s) |
| PASS | insight_preferences | INSERT | User A | other user | denied insert | error 42501: new row violates row-level security policy for table "insight_preferences" |
| PASS | insight_preferences | UPDATE | User A | own user | allowed update | 1 row(s) updated |
| PASS | insight_preferences | UPDATE | User A | other user | denied/no mutation | 0 row(s) updated |
| PASS | insight_preferences | DELETE | User A | other user | denied/no mutation | error 42501: permission denied for table insight_preferences |
| PASS | tax_state_rates | SELECT | User A | global reference | allowed rows | 1 row(s) |
| PASS | tax_state_rates | INSERT | User A | global reference | denied insert | error 42501: permission denied for table tax_state_rates |
| PASS | tax_state_rates | UPDATE | User A | global reference | denied/no mutation | error 42501: permission denied for table tax_state_rates |
| PASS | tax_state_rates | DELETE | User A | global reference | denied/no mutation | error 42501: permission denied for table tax_state_rates |
| PASS | account_breakdown | SELECT | User B | own server-only table | denied/no rows | error 42501: permission denied for table account_breakdown |
| PASS | account_breakdown | SELECT | User B | Business A | denied/no rows | error 42501: permission denied for table account_breakdown |
| PASS | account_breakdown | INSERT | User B | Business A | denied insert | error 42501: permission denied for table account_breakdown |
| PASS | account_breakdown | UPDATE | User B | Business A | denied/no mutation | error PGRST204: Could not find the 'updated_at' column of 'account_breakdown' in the schema cache |
| PASS | account_breakdown | DELETE | User B | Business A | denied/no mutation | error 42501: permission denied for table account_breakdown |
| PASS | affordability_assessments | SELECT | User B | own server-only table | denied/no rows | error 42501: permission denied for table affordability_assessments |
| PASS | affordability_assessments | SELECT | User B | Business A | denied/no rows | error 42501: permission denied for table affordability_assessments |
| PASS | affordability_assessments | INSERT | User B | Business A | denied insert | error 42501: permission denied for table affordability_assessments |
| PASS | affordability_assessments | UPDATE | User B | Business A | denied/no mutation | error PGRST204: Could not find the 'updated_at' column of 'affordability_assessments' in the schema cache |
| PASS | affordability_assessments | DELETE | User B | Business A | denied/no mutation | error 42501: permission denied for table affordability_assessments |
| PASS | balance_sheet_history | SELECT | User B | own server-only table | denied/no rows | error 42501: permission denied for table balance_sheet_history |
| PASS | balance_sheet_history | SELECT | User B | Business A | denied/no rows | error 42501: permission denied for table balance_sheet_history |
| PASS | balance_sheet_history | INSERT | User B | Business A | denied insert | error 42501: permission denied for table balance_sheet_history |
| PASS | balance_sheet_history | UPDATE | User B | Business A | denied/no mutation | error PGRST204: Could not find the 'updated_at' column of 'balance_sheet_history' in the schema cache |
| PASS | balance_sheet_history | DELETE | User B | Business A | denied/no mutation | error 42501: permission denied for table balance_sheet_history |
| PASS | billing_customers | SELECT | User B | own server-only table | denied/no rows | error 42501: permission denied for table billing_customers |
| PASS | billing_customers | SELECT | User B | Business A | denied/no rows | error 42501: permission denied for table billing_customers |
| PASS | billing_customers | INSERT | User B | Business A | denied insert | error 42501: permission denied for table billing_customers |
| PASS | billing_customers | UPDATE | User B | Business A | denied/no mutation | error PGRST204: Could not find the 'updated_at' column of 'billing_customers' in the schema cache |
| PASS | billing_customers | DELETE | User B | Business A | denied/no mutation | error 42501: permission denied for table billing_customers |
| PASS | bizzy_deadlines | SELECT | User B | own server-only table | denied/no rows | error 42501: permission denied for table bizzy_deadlines |
| PASS | bizzy_deadlines | SELECT | User B | Business A | denied/no rows | error 42501: permission denied for table bizzy_deadlines |
| PASS | bizzy_deadlines | INSERT | User B | Business A | denied insert | error 42501: permission denied for table bizzy_deadlines |
| PASS | bizzy_deadlines | UPDATE | User B | Business A | denied/no mutation | error 42501: permission denied for table bizzy_deadlines |
| PASS | bizzy_deadlines | DELETE | User B | Business A | denied/no mutation | error 42501: permission denied for table bizzy_deadlines |
| PASS | bizzy_headlines | SELECT | User B | own server-only table | denied/no rows | error 42501: permission denied for table bizzy_headlines |
| PASS | bizzy_headlines | SELECT | User B | Business A | denied/no rows | error 42501: permission denied for table bizzy_headlines |
| PASS | bizzy_headlines | INSERT | User B | Business A | denied insert | error 42501: permission denied for table bizzy_headlines |
| PASS | bizzy_headlines | UPDATE | User B | Business A | denied/no mutation | error PGRST204: Could not find the 'updated_at' column of 'bizzy_headlines' in the schema cache |
| PASS | bizzy_headlines | DELETE | User B | Business A | denied/no mutation | error 42501: permission denied for table bizzy_headlines |
| PASS | bookkeeping_health | SELECT | User B | own server-only table | denied/no rows | error 42501: permission denied for table bookkeeping_health |
| PASS | bookkeeping_health | SELECT | User B | Business A | denied/no rows | error 42501: permission denied for table bookkeeping_health |
| PASS | bookkeeping_health | INSERT | User B | Business A | denied insert | error 42501: permission denied for table bookkeeping_health |
| PASS | bookkeeping_health | UPDATE | User B | Business A | denied/no mutation | error 42501: permission denied for table bookkeeping_health |
| PASS | bookkeeping_health | DELETE | User B | Business A | denied/no mutation | error 42501: permission denied for table bookkeeping_health |
| PASS | calendar_events | SELECT | User B | own server-only table | denied/no rows | error 42501: permission denied for table calendar_events |
| PASS | calendar_events | SELECT | User B | Business A | denied/no rows | error 42501: permission denied for table calendar_events |
| PASS | calendar_events | INSERT | User B | Business A | denied insert | error 42501: permission denied for table calendar_events |
| PASS | calendar_events | UPDATE | User B | Business A | denied/no mutation | error 42501: permission denied for table calendar_events |
| PASS | calendar_events | DELETE | User B | Business A | denied/no mutation | error 42501: permission denied for table calendar_events |
| PASS | categorization_rules | SELECT | User B | own server-only table | denied/no rows | error 42501: permission denied for table categorization_rules |
| PASS | categorization_rules | SELECT | User B | Business A | denied/no rows | error 42501: permission denied for table categorization_rules |
| PASS | categorization_rules | INSERT | User B | Business A | denied insert | error 42501: permission denied for table categorization_rules |
| PASS | categorization_rules | UPDATE | User B | Business A | denied/no mutation | error 42501: permission denied for table categorization_rules |
| PASS | categorization_rules | DELETE | User B | Business A | denied/no mutation | error 42501: permission denied for table categorization_rules |
| PASS | gpt_messages_backup | SELECT | User B | own server-only table | denied/no rows | error 42501: permission denied for table gpt_messages_backup |
| PASS | gpt_messages_backup | SELECT | User B | Business A | denied/no rows | error 42501: permission denied for table gpt_messages_backup |
| PASS | gpt_messages_backup | INSERT | User B | Business A | denied insert | error 42501: permission denied for table gpt_messages_backup |
| PASS | gpt_messages_backup | UPDATE | User B | Business A | denied/no mutation | error PGRST204: Could not find the 'updated_at' column of 'gpt_messages_backup' in the schema cache |
| PASS | gpt_messages_backup | DELETE | User B | Business A | denied/no mutation | error 42501: permission denied for table gpt_messages_backup |
| PASS | insight_reads | SELECT | User B | own server-only table | denied/no rows | error 42501: permission denied for table insight_reads |
| PASS | insight_reads | SELECT | User B | Business A | denied/no rows | error 42501: permission denied for table insight_reads |
| PASS | insight_reads | INSERT | User B | Business A | denied insert | error 42501: permission denied for table insight_reads |
| PASS | insight_reads | UPDATE | User B | Business A | denied/no mutation | error PGRST204: Could not find the 'updated_at' column of 'insight_reads' in the schema cache |
| PASS | insight_reads | DELETE | User B | Business A | denied/no mutation | error 42501: permission denied for table insight_reads |
| PASS | integration_connections | SELECT | User B | own server-only table | denied/no rows | error 42501: permission denied for table integration_connections |
| PASS | integration_connections | SELECT | User B | Business A | denied/no rows | error 42501: permission denied for table integration_connections |
| PASS | integration_connections | INSERT | User B | Business A | denied insert | error 42501: permission denied for table integration_connections |
| PASS | integration_connections | UPDATE | User B | Business A | denied/no mutation | error 42501: permission denied for table integration_connections |
| PASS | integration_connections | DELETE | User B | Business A | denied/no mutation | error 42501: permission denied for table integration_connections |
| PASS | investment_accounts | SELECT | User B | own server-only table | denied/no rows | error 42501: permission denied for table investment_accounts |
| PASS | investment_accounts | SELECT | User B | Business A | denied/no rows | error 42501: permission denied for table investment_accounts |
| PASS | investment_accounts | INSERT | User B | Business A | denied insert | error 42501: permission denied for table investment_accounts |
| PASS | investment_accounts | UPDATE | User B | Business A | denied/no mutation | error PGRST204: Could not find the 'updated_at' column of 'investment_accounts' in the schema cache |
| PASS | investment_accounts | DELETE | User B | Business A | denied/no mutation | error 42501: permission denied for table investment_accounts |
| PASS | investment_balances | SELECT | User B | own server-only table | denied/no rows | error 42501: permission denied for table investment_balances |
| PASS | investment_balances | SELECT | User B | Business A | denied/no rows | error 42501: permission denied for table investment_balances |
| PASS | investment_balances | INSERT | User B | Business A | denied insert | error 42501: permission denied for table investment_balances |
| PASS | investment_balances | UPDATE | User B | Business A | denied/no mutation | error PGRST204: Could not find the 'updated_at' column of 'investment_balances' in the schema cache |
| PASS | investment_balances | DELETE | User B | Business A | denied/no mutation | error 42501: permission denied for table investment_balances |
| PASS | monthly_forecast | SELECT | User B | own server-only table | denied/no rows | error 42501: permission denied for table monthly_forecast |
| PASS | monthly_forecast | SELECT | User B | Business A | denied/no rows | error 42501: permission denied for table monthly_forecast |
| PASS | monthly_forecast | INSERT | User B | Business A | denied insert | error 42501: permission denied for table monthly_forecast |
| PASS | monthly_forecast | UPDATE | User B | Business A | denied/no mutation | error 42501: permission denied for table monthly_forecast |
| PASS | monthly_forecast | DELETE | User B | Business A | denied/no mutation | error 42501: permission denied for table monthly_forecast |
| PASS | plaid_accounts | SELECT | User B | own server-only table | denied/no rows | error 42501: permission denied for table plaid_accounts |
| PASS | plaid_accounts | SELECT | User B | Business A | denied/no rows | error 42501: permission denied for table plaid_accounts |
| PASS | plaid_accounts | INSERT | User B | Business A | denied insert | error 42501: permission denied for table plaid_accounts |
| PASS | plaid_accounts | UPDATE | User B | Business A | denied/no mutation | error 42501: permission denied for table plaid_accounts |
| PASS | plaid_accounts | DELETE | User B | Business A | denied/no mutation | error 42501: permission denied for table plaid_accounts |
| PASS | plaid_qbo_account_mappings | SELECT | User B | own server-only table | denied/no rows | error 42501: permission denied for table plaid_qbo_account_mappings |
| PASS | plaid_qbo_account_mappings | SELECT | User B | Business A | denied/no rows | error 42501: permission denied for table plaid_qbo_account_mappings |
| PASS | plaid_qbo_account_mappings | INSERT | User B | Business A | denied insert | error 42501: permission denied for table plaid_qbo_account_mappings |
| PASS | plaid_qbo_account_mappings | UPDATE | User B | Business A | denied/no mutation | error 42501: permission denied for table plaid_qbo_account_mappings |
| PASS | plaid_qbo_account_mappings | DELETE | User B | Business A | denied/no mutation | error 42501: permission denied for table plaid_qbo_account_mappings |
| PASS | positions | SELECT | User B | own server-only table | denied/no rows | error 42501: permission denied for table positions |
| PASS | positions | SELECT | User B | Business A | denied/no rows | error 42501: permission denied for table positions |
| PASS | positions | INSERT | User B | Business A | denied insert | error 42501: permission denied for table positions |
| PASS | positions | UPDATE | User B | Business A | denied/no mutation | error PGRST204: Could not find the 'updated_at' column of 'positions' in the schema cache |
| PASS | positions | DELETE | User B | Business A | denied/no mutation | error 42501: permission denied for table positions |
| PASS | qbo_posted_transactions | SELECT | User B | own server-only table | denied/no rows | error 42501: permission denied for table qbo_posted_transactions |
| PASS | qbo_posted_transactions | SELECT | User B | Business A | denied/no rows | error 42501: permission denied for table qbo_posted_transactions |
| PASS | qbo_posted_transactions | INSERT | User B | Business A | denied insert | error 42501: permission denied for table qbo_posted_transactions |
| PASS | qbo_posted_transactions | UPDATE | User B | Business A | denied/no mutation | error 42501: permission denied for table qbo_posted_transactions |
| PASS | qbo_posted_transactions | DELETE | User B | Business A | denied/no mutation | error 42501: permission denied for table qbo_posted_transactions |
| PASS | review_sources | SELECT | User B | own server-only table | denied/no rows | error 42501: permission denied for table review_sources |
| PASS | review_sources | SELECT | User B | Business A | denied/no rows | error 42501: permission denied for table review_sources |
| PASS | review_sources | INSERT | User B | Business A | denied insert | error 42501: permission denied for table review_sources |
| PASS | review_sources | UPDATE | User B | Business A | denied/no mutation | error PGRST204: Could not find the 'updated_at' column of 'review_sources' in the schema cache |
| PASS | review_sources | DELETE | User B | Business A | denied/no mutation | error 42501: permission denied for table review_sources |
| PASS | subscriptions | SELECT | User B | own server-only table | denied/no rows | error 42501: permission denied for table subscriptions |
| PASS | subscriptions | SELECT | User B | Business A | denied/no rows | error 42501: permission denied for table subscriptions |
| PASS | subscriptions | INSERT | User B | Business A | denied insert | error 42501: permission denied for table subscriptions |
| PASS | subscriptions | UPDATE | User B | Business A | denied/no mutation | error 42501: permission denied for table subscriptions |
| PASS | subscriptions | DELETE | User B | Business A | denied/no mutation | error 42501: permission denied for table subscriptions |
| PASS | transaction_categorizations | SELECT | User B | own server-only table | denied/no rows | error 42501: permission denied for table transaction_categorizations |
| PASS | transaction_categorizations | SELECT | User B | Business A | denied/no rows | error 42501: permission denied for table transaction_categorizations |
| PASS | transaction_categorizations | INSERT | User B | Business A | denied insert | error 42501: permission denied for table transaction_categorizations |
| PASS | transaction_categorizations | UPDATE | User B | Business A | denied/no mutation | error 42501: permission denied for table transaction_categorizations |
| PASS | transaction_categorizations | DELETE | User B | Business A | denied/no mutation | error 42501: permission denied for table transaction_categorizations |
| PASS | vendor_rules | SELECT | User B | own server-only table | denied/no rows | error 42501: permission denied for table vendor_rules |
| PASS | vendor_rules | SELECT | User B | Business A | denied/no rows | error 42501: permission denied for table vendor_rules |
| PASS | vendor_rules | INSERT | User B | Business A | denied insert | error 42501: permission denied for table vendor_rules |
| PASS | vendor_rules | UPDATE | User B | Business A | denied/no mutation | error 42501: permission denied for table vendor_rules |
| PASS | vendor_rules | DELETE | User B | Business A | denied/no mutation | error 42501: permission denied for table vendor_rules |
| PASS | cashflow_forecast | SELECT | User B | own server-only table | denied/no rows | error 42501: permission denied for table cashflow_forecast |
| PASS | cashflow_forecast | SELECT | User B | Business A | denied/no rows | error 42501: permission denied for table cashflow_forecast |
| PASS | cashflow_forecast | INSERT | User B | Business A | denied insert | error 42501: permission denied for table cashflow_forecast |
| PASS | cashflow_forecast | UPDATE | User B | Business A | denied/no mutation | error 42501: permission denied for table cashflow_forecast |
| PASS | cashflow_forecast | DELETE | User B | Business A | denied/no mutation | error 42501: permission denied for table cashflow_forecast |
| PASS | gpt_messages | SELECT | User B | own server-only table | denied/no rows | error 42501: permission denied for table gpt_messages |
| PASS | gpt_messages | SELECT | User B | Business A | denied/no rows | error 42501: permission denied for table gpt_messages |
| PASS | gpt_messages | INSERT | User B | Business A | denied insert | error 42501: permission denied for table gpt_messages |
| PASS | gpt_messages | UPDATE | User B | Business A | denied/no mutation | error PGRST204: Could not find the 'updated_at' column of 'gpt_messages' in the schema cache |
| PASS | gpt_messages | DELETE | User B | Business A | denied/no mutation | error 42501: permission denied for table gpt_messages |
| PASS | expense_totals_monthly | SELECT | User B | own tenant | allowed rows | 1 row(s) |
| PASS | expense_totals_monthly | SELECT | User B | Business A | denied/no rows | 0 row(s) |
| PASS | expense_totals_monthly | INSERT | User B | Business A | denied insert | error 42501: permission denied for table expense_totals_monthly |
| PASS | expense_totals_monthly | UPDATE | User B | Business A | denied/no mutation | error 42501: permission denied for table expense_totals_monthly |
| PASS | expense_totals_monthly | DELETE | User B | Business A | denied/no mutation | error 42501: permission denied for table expense_totals_monthly |
| PASS | insights | SELECT | User B | own tenant | allowed rows | 1 row(s) |
| PASS | insights | SELECT | User B | Business A | denied/no rows | 0 row(s) |
| PASS | insights | INSERT | User B | Business A | denied insert | error 42501: permission denied for table insights |
| PASS | insights | UPDATE | User B | Business A | denied/no mutation | error 42501: permission denied for table insights |
| PASS | insights | DELETE | User B | Business A | denied/no mutation | error 42501: permission denied for table insights |
| PASS | tax_deadlines | SELECT | User B | own tenant | allowed rows | 1 row(s) |
| PASS | tax_deadlines | SELECT | User B | Business A | denied/no rows | 0 row(s) |
| PASS | tax_deadlines | INSERT | User B | Business A | denied insert | error 42501: permission denied for table tax_deadlines |
| PASS | tax_deadlines | UPDATE | User B | Business A | denied/no mutation | error 42501: permission denied for table tax_deadlines |
| PASS | tax_deadlines | DELETE | User B | Business A | denied/no mutation | error 42501: permission denied for table tax_deadlines |
| PASS | notifications | SELECT | User B | own user | allowed rows | 1 row(s) |
| PASS | notifications | SELECT | User B | other user | denied/no rows | 0 row(s) |
| PASS | notifications | INSERT | User B | other user | denied insert | error 42501: new row violates row-level security policy for table "notifications" |
| PASS | notifications | UPDATE | User B | own user | allowed update | 1 row(s) updated |
| PASS | notifications | UPDATE | User B | other user | denied/no mutation | 0 row(s) updated |
| PASS | notifications | DELETE | User B | other user | denied/no mutation | error 42501: permission denied for table notifications |
| PASS | profiles | SELECT | User B | own user | allowed rows | 1 row(s) |
| PASS | profiles | SELECT | User B | other user | denied/no rows | 0 row(s) |
| PASS | profiles | INSERT | User B | other user | denied insert | error 42501: new row violates row-level security policy for table "profiles" |
| PASS | profiles | UPDATE | User B | own user | allowed update | 1 row(s) updated |
| PASS | profiles | UPDATE | User B | other user | denied/no mutation | 0 row(s) updated |
| PASS | profiles | DELETE | User B | other user | denied/no mutation | error 42501: permission denied for table profiles |
| PASS | insight_preferences | SELECT | User B | own user | allowed rows | 1 row(s) |
| PASS | insight_preferences | SELECT | User B | other user | denied/no rows | 0 row(s) |
| PASS | insight_preferences | INSERT | User B | other user | denied insert | error 42501: new row violates row-level security policy for table "insight_preferences" |
| PASS | insight_preferences | UPDATE | User B | own user | allowed update | 1 row(s) updated |
| PASS | insight_preferences | UPDATE | User B | other user | denied/no mutation | 0 row(s) updated |
| PASS | insight_preferences | DELETE | User B | other user | denied/no mutation | error 42501: permission denied for table insight_preferences |
| PASS | tax_state_rates | SELECT | User B | global reference | allowed rows | 1 row(s) |
| PASS | tax_state_rates | INSERT | User B | global reference | denied insert | error 42501: permission denied for table tax_state_rates |
| PASS | tax_state_rates | UPDATE | User B | global reference | denied/no mutation | error 42501: permission denied for table tax_state_rates |
| PASS | tax_state_rates | DELETE | User B | global reference | denied/no mutation | error 42501: permission denied for table tax_state_rates |
| PASS | account_breakdown | SELECT | Anonymous | private or authenticated-only data | denied/no rows | error 42501: permission denied for table account_breakdown |
| PASS | affordability_assessments | SELECT | Anonymous | private or authenticated-only data | denied/no rows | error 42501: permission denied for table affordability_assessments |
| PASS | balance_sheet_history | SELECT | Anonymous | private or authenticated-only data | denied/no rows | error 42501: permission denied for table balance_sheet_history |
| PASS | billing_customers | SELECT | Anonymous | private or authenticated-only data | denied/no rows | error 42501: permission denied for table billing_customers |
| PASS | bizzy_deadlines | SELECT | Anonymous | private or authenticated-only data | denied/no rows | error 42501: permission denied for table bizzy_deadlines |
| PASS | bizzy_headlines | SELECT | Anonymous | private or authenticated-only data | denied/no rows | error 42501: permission denied for table bizzy_headlines |
| PASS | bookkeeping_health | SELECT | Anonymous | private or authenticated-only data | denied/no rows | error 42501: permission denied for table bookkeeping_health |
| PASS | calendar_events | SELECT | Anonymous | private or authenticated-only data | denied/no rows | error 42501: permission denied for table calendar_events |
| PASS | categorization_rules | SELECT | Anonymous | private or authenticated-only data | denied/no rows | error 42501: permission denied for table categorization_rules |
| PASS | gpt_messages_backup | SELECT | Anonymous | private or authenticated-only data | denied/no rows | error 42501: permission denied for table gpt_messages_backup |
| PASS | insight_reads | SELECT | Anonymous | private or authenticated-only data | denied/no rows | error 42501: permission denied for table insight_reads |
| PASS | integration_connections | SELECT | Anonymous | private or authenticated-only data | denied/no rows | error 42501: permission denied for table integration_connections |
| PASS | investment_accounts | SELECT | Anonymous | private or authenticated-only data | denied/no rows | error 42501: permission denied for table investment_accounts |
| PASS | investment_balances | SELECT | Anonymous | private or authenticated-only data | denied/no rows | error 42501: permission denied for table investment_balances |
| PASS | monthly_forecast | SELECT | Anonymous | private or authenticated-only data | denied/no rows | error 42501: permission denied for table monthly_forecast |
| PASS | plaid_accounts | SELECT | Anonymous | private or authenticated-only data | denied/no rows | error 42501: permission denied for table plaid_accounts |
| PASS | plaid_qbo_account_mappings | SELECT | Anonymous | private or authenticated-only data | denied/no rows | error 42501: permission denied for table plaid_qbo_account_mappings |
| PASS | positions | SELECT | Anonymous | private or authenticated-only data | denied/no rows | error 42501: permission denied for table positions |
| PASS | qbo_posted_transactions | SELECT | Anonymous | private or authenticated-only data | denied/no rows | error 42501: permission denied for table qbo_posted_transactions |
| PASS | review_sources | SELECT | Anonymous | private or authenticated-only data | denied/no rows | error 42501: permission denied for table review_sources |
| PASS | subscriptions | SELECT | Anonymous | private or authenticated-only data | denied/no rows | error 42501: permission denied for table subscriptions |
| PASS | transaction_categorizations | SELECT | Anonymous | private or authenticated-only data | denied/no rows | error 42501: permission denied for table transaction_categorizations |
| PASS | vendor_rules | SELECT | Anonymous | private or authenticated-only data | denied/no rows | error 42501: permission denied for table vendor_rules |
| PASS | cashflow_forecast | SELECT | Anonymous | private or authenticated-only data | denied/no rows | error 42501: permission denied for table cashflow_forecast |
| PASS | gpt_messages | SELECT | Anonymous | private or authenticated-only data | denied/no rows | error 42501: permission denied for table gpt_messages |
| PASS | expense_totals_monthly | SELECT | Anonymous | private or authenticated-only data | denied/no rows | error 42501: permission denied for table expense_totals_monthly |
| PASS | insights | SELECT | Anonymous | private or authenticated-only data | denied/no rows | error 42501: permission denied for table insights |
| PASS | tax_deadlines | SELECT | Anonymous | private or authenticated-only data | denied/no rows | error 42501: permission denied for table tax_deadlines |
| PASS | notifications | SELECT | Anonymous | private or authenticated-only data | denied/no rows | error 42501: permission denied for table notifications |
| PASS | profiles | SELECT | Anonymous | private or authenticated-only data | denied/no rows | error 42501: permission denied for table profiles |
| PASS | insight_preferences | SELECT | Anonymous | private or authenticated-only data | denied/no rows | error 42501: permission denied for table insight_preferences |
| PASS | tax_state_rates | SELECT | Anonymous | private or authenticated-only data | denied/no rows | error 42501: permission denied for table tax_state_rates |
| PASS | ar_aging | SELECT | User A | own server-only view | denied/no rows | error 42501: permission denied for view ar_aging |
| PASS | ar_aging | SELECT | User A | Business B | denied/no rows | error 42501: permission denied for view ar_aging |
| PASS | ar_aging_v2 | SELECT | User A | own server-only view | denied/no rows | error 42501: permission denied for view ar_aging_v2 |
| PASS | ar_aging_v2 | SELECT | User A | Business B | denied/no rows | error 42501: permission denied for view ar_aging_v2 |
| PASS | billing_customer_overview | SELECT | User A | own server-only view | denied/no rows | error 42501: permission denied for view billing_customer_overview |
| PASS | billing_customer_overview | SELECT | User A | Business B | denied/no rows | error 42501: permission denied for view billing_customer_overview |
| PASS | expense_categories | SELECT | User A | own server-only view | denied/no rows | error 42501: permission denied for view expense_categories |
| PASS | expense_categories | SELECT | User A | Business B | denied/no rows | error 42501: permission denied for view expense_categories |
| PASS | insights_history | SELECT | User A | own server-only view | denied/no rows | error 42501: permission denied for view insights_history |
| PASS | insights_history | SELECT | User A | Business B | denied/no rows | error 42501: permission denied for view insights_history |
| PASS | jobs_profitability | SELECT | User A | own server-only view | denied/no rows | error 42501: permission denied for view jobs_profitability |
| PASS | jobs_profitability | SELECT | User A | Business B | denied/no rows | error 42501: permission denied for view jobs_profitability |
| PASS | positions_view | SELECT | User A | own server-only view | denied/no rows | error 42501: permission denied for view positions_view |
| PASS | positions_view | SELECT | User A | Business B | denied/no rows | error 42501: permission denied for view positions_view |
| PASS | rpc:bizzi_current_user_is_business_member | RPC | User A | own tenant | allowed result true | result true |
| PASS | rpc:bizzi_current_user_is_business_member | RPC | User A | Business B | allowed result false | result false |
| PASS | rpc:bizzi_current_user_can_manage_business | RPC | User A | own tenant | allowed result true | result true |
| PASS | rpc:bizzi_current_user_can_manage_business | RPC | User A | Business B | allowed result false | result false |
| PASS | rpc:tax_user_owns_business | RPC | User A | own tenant | allowed result true | result true |
| PASS | rpc:tax_user_owns_business | RPC | User A | Business B | allowed result false | result false |
| PASS | ar_aging | SELECT | User B | own server-only view | denied/no rows | error 42501: permission denied for view ar_aging |
| PASS | ar_aging | SELECT | User B | Business A | denied/no rows | error 42501: permission denied for view ar_aging |
| PASS | ar_aging_v2 | SELECT | User B | own server-only view | denied/no rows | error 42501: permission denied for view ar_aging_v2 |
| PASS | ar_aging_v2 | SELECT | User B | Business A | denied/no rows | error 42501: permission denied for view ar_aging_v2 |
| PASS | billing_customer_overview | SELECT | User B | own server-only view | denied/no rows | error 42501: permission denied for view billing_customer_overview |
| PASS | billing_customer_overview | SELECT | User B | Business A | denied/no rows | error 42501: permission denied for view billing_customer_overview |
| PASS | expense_categories | SELECT | User B | own server-only view | denied/no rows | error 42501: permission denied for view expense_categories |
| PASS | expense_categories | SELECT | User B | Business A | denied/no rows | error 42501: permission denied for view expense_categories |
| PASS | insights_history | SELECT | User B | own server-only view | denied/no rows | error 42501: permission denied for view insights_history |
| PASS | insights_history | SELECT | User B | Business A | denied/no rows | error 42501: permission denied for view insights_history |
| PASS | jobs_profitability | SELECT | User B | own server-only view | denied/no rows | error 42501: permission denied for view jobs_profitability |
| PASS | jobs_profitability | SELECT | User B | Business A | denied/no rows | error 42501: permission denied for view jobs_profitability |
| PASS | positions_view | SELECT | User B | own server-only view | denied/no rows | error 42501: permission denied for view positions_view |
| PASS | positions_view | SELECT | User B | Business A | denied/no rows | error 42501: permission denied for view positions_view |
| PASS | rpc:bizzi_current_user_is_business_member | RPC | User B | own tenant | allowed result true | result true |
| PASS | rpc:bizzi_current_user_is_business_member | RPC | User B | Business A | allowed result false | result false |
| PASS | rpc:bizzi_current_user_can_manage_business | RPC | User B | own tenant | allowed result true | result true |
| PASS | rpc:bizzi_current_user_can_manage_business | RPC | User B | Business A | allowed result false | result false |
| PASS | rpc:tax_user_owns_business | RPC | User B | own tenant | allowed result true | result true |
| PASS | rpc:tax_user_owns_business | RPC | User B | Business A | allowed result false | result false |
| PASS | rpc:acquire_posting_lock | RPC | User A | Business B | denied execution | error PGRST203: Could not choose the best candidate function between: public.acquire_posting_lock(p_business_id => uuid, p_transaction_id => text, p_now_iso => timestamp with time zone, p_lock_stale_seconds => integer, p_idempotency_key => text), public.acquire_posting_lock(p_business_id => uuid, p_transaction_id => uuid, p_now_iso => timestamp with time zone, p_lock_stale_seconds => integer, p_idempotency_key => text) |
| PASS | rpc:claim_contractor_cfo_insight_run | RPC | User A | Business B | denied execution | error 42501: permission denied for function claim_contractor_cfo_insight_run |
| PASS | rpc:claim_scheduled_job_lock | RPC | User A | Business B | denied execution | error 42501: permission denied for function claim_scheduled_job_lock |
| PASS | rpc:refresh_billing_identity_summary | RPC | User A | Business B | denied execution | error 42501: permission denied for function refresh_billing_identity_summary |
| PASS | rpc:get_tax_deduction_transaction_drilldown | RPC | User A | Business B | denied execution | error 42501: permission denied for function get_tax_deduction_transaction_drilldown |
| PASS | rpc:is_member | RPC | User A | Business B | denied execution | error 42501: permission denied for function is_member |
| PASS | rpc:recalc_thread_last_message | RPC | User A | Business B | denied execution | error 42501: permission denied for function recalc_thread_last_message |
| PASS | rpc:create_initial_business_for_user | RPC | User A | Business B | denied execution | error 42501: permission denied for function create_initial_business_for_user |
| PASS | rpc:acquire_posting_lock | RPC | User B | Business A | denied execution | error PGRST203: Could not choose the best candidate function between: public.acquire_posting_lock(p_business_id => uuid, p_transaction_id => text, p_now_iso => timestamp with time zone, p_lock_stale_seconds => integer, p_idempotency_key => text), public.acquire_posting_lock(p_business_id => uuid, p_transaction_id => uuid, p_now_iso => timestamp with time zone, p_lock_stale_seconds => integer, p_idempotency_key => text) |
| PASS | rpc:claim_contractor_cfo_insight_run | RPC | User B | Business A | denied execution | error 42501: permission denied for function claim_contractor_cfo_insight_run |
| PASS | rpc:claim_scheduled_job_lock | RPC | User B | Business A | denied execution | error 42501: permission denied for function claim_scheduled_job_lock |
| PASS | rpc:refresh_billing_identity_summary | RPC | User B | Business A | denied execution | error 42501: permission denied for function refresh_billing_identity_summary |
| PASS | rpc:get_tax_deduction_transaction_drilldown | RPC | User B | Business A | denied execution | error 42501: permission denied for function get_tax_deduction_transaction_drilldown |
| PASS | rpc:is_member | RPC | User B | Business A | denied execution | error 42501: permission denied for function is_member |
| PASS | rpc:recalc_thread_last_message | RPC | User B | Business A | denied execution | error 42501: permission denied for function recalc_thread_last_message |
| PASS | rpc:create_initial_business_for_user | RPC | User B | Business A | denied execution | error 42501: permission denied for function create_initial_business_for_user |
| PASS | ar_aging | SELECT | Anonymous | server-only view | denied/no rows | error 42501: permission denied for view ar_aging |
| PASS | ar_aging_v2 | SELECT | Anonymous | server-only view | denied/no rows | error 42501: permission denied for view ar_aging_v2 |
| PASS | billing_customer_overview | SELECT | Anonymous | server-only view | denied/no rows | error 42501: permission denied for view billing_customer_overview |
| PASS | expense_categories | SELECT | Anonymous | server-only view | denied/no rows | error 42501: permission denied for view expense_categories |
| PASS | insights_history | SELECT | Anonymous | server-only view | denied/no rows | error 42501: permission denied for view insights_history |
| PASS | jobs_profitability | SELECT | Anonymous | server-only view | denied/no rows | error 42501: permission denied for view jobs_profitability |
| PASS | positions_view | SELECT | Anonymous | server-only view | denied/no rows | error 42501: permission denied for view positions_view |
| PASS | rpc:bizzi_current_user_is_business_member | RPC | Anonymous | RLS helper | denied execution | error 42501: permission denied for function bizzi_current_user_is_business_member |
| PASS | rpc:acquire_posting_lock | RPC | Anonymous | backend-only RPC | denied execution | error PGRST203: Could not choose the best candidate function between: public.acquire_posting_lock(p_business_id => uuid, p_transaction_id => text, p_now_iso => timestamp with time zone, p_lock_stale_seconds => integer, p_idempotency_key => text), public.acquire_posting_lock(p_business_id => uuid, p_transaction_id => uuid, p_now_iso => timestamp with time zone, p_lock_stale_seconds => integer, p_idempotency_key => text) |
| PASS | rpc:claim_contractor_cfo_insight_run | RPC | Anonymous | backend-only RPC | denied execution | error 42501: permission denied for function claim_contractor_cfo_insight_run |
| PASS | rpc:claim_scheduled_job_lock | RPC | Anonymous | backend-only RPC | denied execution | error 42501: permission denied for function claim_scheduled_job_lock |
| PASS | rpc:refresh_billing_identity_summary | RPC | Anonymous | backend-only RPC | denied execution | error 42501: permission denied for function refresh_billing_identity_summary |
| PASS | rpc:get_tax_deduction_transaction_drilldown | RPC | Anonymous | backend-only RPC | denied execution | error 42501: permission denied for function get_tax_deduction_transaction_drilldown |
| PASS | rpc:is_member | RPC | Anonymous | backend-only RPC | denied execution | error 42501: permission denied for function is_member |
| PASS | rpc:recalc_thread_last_message | RPC | Anonymous | backend-only RPC | denied execution | error 42501: permission denied for function recalc_thread_last_message |
| PASS | rpc:create_initial_business_for_user | RPC | Anonymous | backend-only RPC | denied execution | error 42501: permission denied for function create_initial_business_for_user |

## Explicit Answers

- Can User A SELECT User B's profile?: **NO**
- Can User A SELECT Business B?: **NO**
- Can User A UPDATE Business B?: **NO**
- Can User A attach themselves to Business B?: **NO**
- Can User A elevate themselves to owner/admin for Business B?: **NO**
- Can User A alter ownership fields on Business B?: **NO**
- Can User A directly read another tenant's financial records?: **NO**
- Can User A directly mutate another tenant's financial records?: **NO**
- Can authenticated users directly read QBO/Plaid/OAuth credential tables?: **NO**
- Can anonymous users read any private customer data?: **NO**
- Does RLS actually isolate the two businesses at runtime?: **YES**
- Which exact policies/settings must be fixed next?: **See failed tests; likely business_profiles USING true, user_business_link WITH CHECK true, RLS-disabled tables with anon/authenticated ALL grants, and credential table browser grants.**
- Is the authorization foundation safe enough to build the rest of the RLS model upon?: **YES**

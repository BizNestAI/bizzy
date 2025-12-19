// File: /src/api/gpt/parsers/affordabilityParser.js

// Step #1: Intent Detection
export function detectAffordabilityIntent(message) {
  const patterns = [
    /can i afford/i,
    /can we afford/i,
    /should i spend/i,
    /should we spend/i,
    /is it (okay|safe) to/i,
    /can i pay for/i,
    /can we hire/i,
    /can i hire/i,
    /do i have enough/i,
    /would it be smart to/i,
    /can i budget for/i
  ];

  return patterns.some((regex) => regex.test(message));
}

// Step #2: Basic Entity Extraction (fallback only — can replace with GPT later)
export function extractExpenseDetails(message) {
  const lower = message.toLowerCase();

  let expenseName = 'Unnamed Expense';

  if (lower.includes('hire')) expenseName = 'Hire new employee';
  else if (lower.includes('truck')) expenseName = 'Buy new truck';
  else if (lower.includes('crm')) expenseName = 'CRM software upgrade';
  else if (lower.includes('marketing')) expenseName = 'Marketing campaign';
  else if (lower.includes('office')) expenseName = 'New office lease';

  const amountMatch = message.match(/\$?(\d{1,3}(,\d{3})*(\.\d{1,2})?|\d+(\.\d{1,2})?)/);
  const amount = amountMatch ? parseFloat(amountMatch[0].replace(/,/g, '')) : null;

  return {
    expenseName,
    amount,
    frequency: 'One-time',
    startDate: null,
    notes: message
  };
}

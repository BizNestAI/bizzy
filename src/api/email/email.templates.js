// src/api/email/email.templates.js

export function applyTemplate(name, vars = {}) {
  switch (name) {
    case 'quote_followup':
      return {
        subject: `Following up on your estimate${vars.project ? ` for ${vars.project}` : ''}`,
        body: `Hi ${vars.clientName || 'there'},\n\nHope you're well. I wanted to follow up on the estimate${vars.project ? ` for ${vars.project}` : ''}. If you have any questions or want to move forward, just reply and we’ll get you on the schedule.\n\nThanks,\n${vars.senderName || 'Team'}`,
      };
    case 'payment_reminder':
      return {
        subject: `Invoice ${vars.invoiceNumber || ''} Reminder`,
        body: `Hi ${vars.clientName || 'there'},\n\nJust a reminder that invoice ${vars.invoiceNumber || ''} in the amount of $${vars.amount || ''} is due ${vars.dueDate || 'soon'}. Here's the link to pay: ${vars.payLink || '[payment link]'}\n\nThanks,\n${vars.senderName || 'Team'}`,
      };
    case 'scheduling':
      return {
        subject: `Scheduling availability`,
        body: `Hi ${vars.clientName || 'there'},\n\nWe have availability ${vars.timeSlots || 'this week'}. Let us know which works for you and we’ll confirm.\n\nThanks,\n${vars.senderName || 'Team'}`,
      };
    default:
      return { subject: vars.subject || '', body: vars.body || '' };
  }
}

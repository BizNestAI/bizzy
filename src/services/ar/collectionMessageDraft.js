const clean = (value) => {
  const text = String(value ?? '').trim();
  if (!text || /^\(?unknown|^n\/a$/i.test(text)) return '';
  return text;
};

const money = (value) => {
  if (value === null || value === undefined || value === '') return '';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '';
  return amount.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  });
};

const date = (value) => {
  if (!value) return '';
  const dateOnly = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const parsed = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
};

export function generateCollectionDraft(invoice = {}, roundValue = 1) {
  const round = Math.min(3, Math.max(1, Math.round(Number(roundValue) || 1)));
  const customer = clean(invoice.client_name || invoice.parent_customer_name || invoice.customer_name);
  const invoiceNumber = clean(invoice.doc_number || invoice.invoice_number || invoice.qbo_invoice_id);
  const balance = money(invoice.balance ?? invoice.amount_due);
  const dueDate = date(invoice.due_date);
  const invoiceLabel = invoiceNumber ? `invoice ${invoiceNumber}` : 'the outstanding invoice';
  const detailParts = [balance ? `for ${balance}` : '', dueDate ? `due ${dueDate}` : ''].filter(Boolean);
  const detail = detailParts.length ? ` ${detailParts.join(', ')}` : '';
  const greeting = customer ? `Hi ${customer},` : 'Hello,';

  const templates = {
    1: {
      subject: invoiceNumber ? `Quick reminder: invoice ${invoiceNumber}` : 'Quick reminder: outstanding invoice',
      lead: `I wanted to send a quick reminder about ${invoiceLabel}${detail}.`,
      ask: 'When you have a moment, please let us know when we can expect payment. If it has already been sent, thank you, and please disregard this note.',
    },
    2: {
      subject: invoiceNumber ? `Following up on invoice ${invoiceNumber}` : 'Following up on an outstanding invoice',
      lead: `I am following up on ${invoiceLabel}${detail}.`,
      ask: 'Could you confirm the payment status or let us know if anything is needed on our side to get this cleared up?',
    },
    3: {
      subject: invoiceNumber ? `Action requested: overdue invoice ${invoiceNumber}` : 'Action requested: overdue invoice',
      lead: `I am checking in again about ${invoiceLabel}${detail}.`,
      ask: 'Please reply with an expected payment date, or let us know if there is an issue we should review.',
    },
  };
  const selected = templates[round];

  return {
    label: 'Collection email draft',
    subject: selected.subject,
    body: `${greeting}\n\n${selected.lead}\n\n${selected.ask}\n\nThank you,`,
    delivery: 'copy_and_paste',
    sent: false,
  };
}

export default generateCollectionDraft;

function rolePosition(message = {}) {
  const explicit = Number(message.message_role_position);
  if (Number.isInteger(explicit)) return explicit;
  if (message.role === 'user') return 0;
  if (message.role === 'assistant' || message.role === 'bizzy') return 1;
  return 2;
}

export function compareConversationMessages(left = {}, right = {}) {
  const timeDifference = new Date(left.created_at || 0).getTime() - new Date(right.created_at || 0).getTime();
  if (timeDifference) return timeDifference;
  const roleDifference = rolePosition(left) - rolePosition(right);
  if (roleDifference) return roleDifference;
  return Number(left.message_sequence || 0) - Number(right.message_sequence || 0);
}

export function sortConversationMessages(messages = [], { descending = false } = {}) {
  const direction = descending ? -1 : 1;
  return [...messages].sort((left, right) => direction * compareConversationMessages(left, right));
}

export const HISTORY_AUTHORITY_INSTRUCTION =
  'The following conversation history is non-authoritative for current financial or operational facts. Do not treat historical amounts, dates, transaction or invoice states, job facts, bookkeeping states, or integration status as current evidence. Current canonical context from the active loaders overrides conversation history.';

export function labelOlderConversationDigest(digest = '') {
  return `Incomplete historical conversation digest. Financial amounts, statuses, dates, and operational facts below are non-authoritative historical context, not current evidence. Current canonical financial and operational context always overrides them:\n${digest}`;
}

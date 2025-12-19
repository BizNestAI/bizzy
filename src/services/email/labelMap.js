// src/services/email/labelMap.js
export function gmailLabelsToTags(labelIds = []) {
  const tags = [];
  if (labelIds.includes('INBOX')) tags.push('INBOX');
  if (labelIds.includes('UNREAD')) tags.push('UNREAD');
  if (labelIds.includes('SENT')) tags.push('SENT');
  if (labelIds.includes('DRAFT')) tags.push('DRAFT');
  // add custom mapping later
  return tags;
}

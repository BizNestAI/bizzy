export const QBO_DUPLICATE_CANDIDATE_STATES = Object.freeze({
  AVAILABLE_MATCH: "available_match",
  LINKED_TO_THIS: "already_linked_to_this_transaction",
  LINKED_TO_ANOTHER: "already_linked_to_another_transaction",
  POSSIBLE_UNCONSUMED: "possible_unconsumed_duplicate",
  CONFIRMED_DUPLICATE: "confirmed_duplicate",
  PROVIDER_AMBIGUOUS: "provider_outcome_ambiguous",
});

export function classifyQboDuplicateCandidate(candidate = {}, {
  transactionId = null,
  consumerTransactionIds = [],
  confirmedDuplicate = false,
  providerOutcomeAmbiguous = false,
} = {}) {
  const consumers = new Set((consumerTransactionIds || []).filter(Boolean).map(String));
  const current = String(transactionId || "");
  let candidateState = QBO_DUPLICATE_CANDIDATE_STATES.POSSIBLE_UNCONSUMED;
  if (providerOutcomeAmbiguous) candidateState = QBO_DUPLICATE_CANDIDATE_STATES.PROVIDER_AMBIGUOUS;
  else if (confirmedDuplicate || candidate?.deterministic === true) candidateState = QBO_DUPLICATE_CANDIDATE_STATES.CONFIRMED_DUPLICATE;
  else if (current && consumers.has(current)) candidateState = QBO_DUPLICATE_CANDIDATE_STATES.LINKED_TO_THIS;
  else if ([...consumers].some((id) => id !== current)) candidateState = QBO_DUPLICATE_CANDIDATE_STATES.LINKED_TO_ANOTHER;
  else if (candidate?.matchable === true || candidate?.payee_matches === true) candidateState = QBO_DUPLICATE_CANDIDATE_STATES.AVAILABLE_MATCH;
  return {
    ...candidate,
    candidate_state: candidateState,
    consumed_by_another_transaction: candidateState === QBO_DUPLICATE_CANDIDATE_STATES.LINKED_TO_ANOTHER,
    matchable: [QBO_DUPLICATE_CANDIDATE_STATES.AVAILABLE_MATCH, QBO_DUPLICATE_CANDIDATE_STATES.POSSIBLE_UNCONSUMED].includes(candidateState),
    informational_only: candidateState === QBO_DUPLICATE_CANDIDATE_STATES.LINKED_TO_ANOTHER,
  };
}

export function canOverrideReviewedCandidate(candidate = {}) {
  return [
    QBO_DUPLICATE_CANDIDATE_STATES.AVAILABLE_MATCH,
    QBO_DUPLICATE_CANDIDATE_STATES.POSSIBLE_UNCONSUMED,
    QBO_DUPLICATE_CANDIDATE_STATES.LINKED_TO_ANOTHER,
  ].includes(candidate.candidate_state);
}

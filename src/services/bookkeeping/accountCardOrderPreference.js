export function getAccountCardOrderKey({ businessId, userId } = {}) {
  const business = String(businessId || "demo");
  const user = String(userId || "anonymous");
  return `bizzi:books-review:account-card-order:${business}:${user}`;
}

export function orderAccountCards(cards = [], preferredOrder = []) {
  const positionByKey = new Map(
    preferredOrder.map((key, index) => [String(key), index])
  );

  return cards
    .map((card, sourceIndex) => ({ card, sourceIndex }))
    .sort((left, right) => {
      const leftPosition = positionByKey.get(String(left.card?._key || left.card?.id || ""));
      const rightPosition = positionByKey.get(String(right.card?._key || right.card?.id || ""));
      const leftKnown = Number.isInteger(leftPosition);
      const rightKnown = Number.isInteger(rightPosition);

      if (leftKnown && rightKnown) return leftPosition - rightPosition;
      if (leftKnown) return -1;
      if (rightKnown) return 1;
      return left.sourceIndex - right.sourceIndex;
    })
    .map(({ card }) => card);
}

export function moveAccountCard(cards = [], draggedKey, targetKey) {
  const keys = cards
    .map((card) => card?._key || card?.id || null)
    .filter(Boolean)
    .map(String);
  const fromIndex = keys.indexOf(String(draggedKey));
  const toIndex = keys.indexOf(String(targetKey));

  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return keys;

  const [movedKey] = keys.splice(fromIndex, 1);
  keys.splice(toIndex, 0, movedKey);
  return keys;
}

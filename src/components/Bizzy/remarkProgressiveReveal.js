const TEXT_NODES = new Set(["text", "inlineCode", "code"]);

function takeCharacters(value, limit) {
  const characters = Array.from(String(value || ""));
  return {
    value: characters.slice(0, Math.max(0, limit)).join(""),
    used: Math.min(characters.length, Math.max(0, limit)),
  };
}

// Parse the complete Markdown document, then reveal only its rendered text.
// Markdown delimiters never become text nodes, so partial animation frames keep
// the same safe formatting tree as the completed message.
export function remarkProgressiveReveal({ visibleCharacters = Infinity } = {}) {
  return function transformer(tree) {
    let remaining = Number.isFinite(visibleCharacters)
      ? Math.max(0, Math.floor(visibleCharacters))
      : Infinity;

    function reveal(node) {
      if (!node || remaining <= 0) return false;

      if (TEXT_NODES.has(node.type)) {
        const next = takeCharacters(node.value, remaining);
        node.value = next.value;
        remaining -= next.used;
        return next.used > 0;
      }

      // Raw HTML is never needed for chat Markdown and must not be surfaced as
      // source while an animation is incomplete.
      if (node.type === "html") return false;

      if (Array.isArray(node.children)) {
        const revealedChildren = [];
        for (const child of node.children) {
          if (reveal(child)) revealedChildren.push(child);
          if (remaining <= 0) break;
        }
        node.children = revealedChildren;
        return revealedChildren.length > 0;
      }

      return remaining > 0;
    }

    reveal(tree);
  };
}

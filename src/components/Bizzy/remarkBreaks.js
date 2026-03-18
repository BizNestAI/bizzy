import { visit } from 'unist-util-visit';

// Minimal replacement for remark-breaks to treat single newlines as <br>
export function remarkBreaksLite() {
  return function transformer(tree) {
    visit(tree, 'text', (node, index, parent) => {
      if (!parent || typeof index !== 'number') return;
      const parts = String(node.value || '').split(/\n/g);
      if (parts.length <= 1) return;

      const nodes = [];
      parts.forEach((part, i) => {
        if (part) nodes.push({ type: 'text', value: part });
        if (i !== parts.length - 1) nodes.push({ type: 'break' });
      });

      parent.children.splice(index, 1, ...nodes);
    });
  };
}

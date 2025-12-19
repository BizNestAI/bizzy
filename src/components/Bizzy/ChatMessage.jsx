// File: /src/components/Bizzy/ChatMessage.jsx
import React from 'react';

/**
 * ChatMessage
 * Presentational-only bubble with ChatGPT-like spacing.
 * You pass the bubble "side" (user|assistant), visual colors, and children.
 */
export default function ChatMessage({
  side = 'assistant',          // 'assistant' | 'user'
  children,                    // content already rendered (Markdown, Typewriter, etc.)
  accentFill = 'rgba(255,78,235,0.10)',
  accentBorder = 'rgba(255,78,235,0.45)',
}) {
  const isUser = side === 'user';

  // Tight, readable, ChatGPT-ish prose
  // - smaller vertical gaps for p/list
  // - modest heading margins
  // - slightly denser line-height than before
  const proseTight =
    'prose prose-invert max-w-none ' +
    'prose-p:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-1 ' +
    'prose-headings:my-3 prose-h2:mb-2 prose-h3:mb-1 ' +
    '[&_*]:leading-[1.55]'; // ~1.55 line-height ≈ ChatGPT feel

  const common =
    'w-fit max-w-[92%] sm:max-w-[85%] md:max-w-[80%] rounded-2xl px-5 py-4 ' +
    'text-[15px] ';

  const userStyles =
    'ml-auto bg-white/8 border border-white/12 text-white shadow-sm';

  const assistantStyles = {
    background: accentFill,
    border: `1px solid ${accentBorder}`,
    boxShadow: `0 0 18px ${accentBorder.replace('0.45', '0.20')}`,
  };

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`${common} ${isUser ? userStyles : 'mr-auto text-white'}`}
        style={isUser ? undefined : assistantStyles}
      >
        {/* children should already be Markdown or Typewriter output */}
        <div className={isUser ? '' : proseTight}>{children}</div>
      </div>
    </div>
  );
}

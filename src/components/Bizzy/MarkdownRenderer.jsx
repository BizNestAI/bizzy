// /src/components/Bizzy/MarkdownRenderer.jsx
import React, { useMemo, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/* ---------- normalize unchanged ---------- */
function normalizeMarkdown(raw, { demoteBoldLabels = false, autoLinkify = true } = {}) {
  if (!raw || typeof raw !== "string") return "";

  const linkify = (text) => {
    if (!autoLinkify) return text;
    // Convert bare URLs/domains to markdown links; keeps code fences untouched.
    return text.replace(
      /(^|[\s(>])((https?:\/\/[^\s<]+)|(www\.[^\s<]+)|((?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,})(\/[^\s<]*)?)(?=$|[\s)<])/g,
      (_m, prefix, url) => {
        const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
        return `${prefix}[${url}](${href})`;
      }
    );
  };

  const parts = raw.split(/(```[\s\S]*?```)/g);
  const out = parts.map((chunk) => {
    const isFence = /^```/.test(chunk);
    if (isFence) return chunk;
    let s = chunk;
    s = s.replace(/\r/g, "");
    s = s.replace(/[ \t]+\n/g, "\n");
    s = s.replace(/\n{3,}/g, "\n\n");
    s = s.replace(/[ \t]{2,}/g, " ");
    if (demoteBoldLabels) {
      s = s.replace(/^\s*\*\*([^*]+?)\*\*:\s*$/gmi, (_m, label) => `${label.trim()}:`);
    }
    s = linkify(s);
    return s;
  });
  return out.join("");
}

export default function MarkdownRenderer({
  value,
  children,
  className = "",
  normalize = true,
  demoteBoldLabels = false,
  autoLinkify = true,
  components,
  rehypePlugins = [],
}) {
  const mergedComponents = useMemo(() => ({
    a: ({ node, ...props }) => (
      <a
        {...props}
        target="_blank"
        rel="noopener noreferrer"
      >
        {props.children}
      </a>
    ),
    ...(components || {}),
  }), [components]);
  const mergedRehype = useMemo(() => [...rehypePlugins], [rehypePlugins]);

  // Load a slim, bright sans (not Grok’s exact font)
  useEffect(() => {
    const id = "pj-sans-font";
    if (!document.getElementById(id)) {
      const link = document.createElement("link");
      link.id = id;
      link.rel = "stylesheet";
      link.href =
        "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600&display=swap";
      document.head.appendChild(link);
    }
  }, []);

  let src = "";
  if (typeof value === "string") src = value;
  else if (typeof children === "string") src = children;
  else if (Array.isArray(children)) src = children.filter((n) => typeof n === "string").join("");

  const clean = useMemo(() => {
    if (!normalize) return src || "";
    return normalizeMarkdown(src || "", { demoteBoldLabels, autoLinkify });
  }, [src, normalize, demoteBoldLabels, autoLinkify]);

  return (
    <div className={`prose-bizzy max-w-none ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={mergedRehype}
        components={mergedComponents}
      >
        {clean}
      </ReactMarkdown>

      {/* Grok-ish, bright slim typography */}
      <style>{`
        .prose-bizzy {
          font-family: 'Plus Jakarta Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial;
          color: #F2F3F4;              /* bright text */
          font-size: 15.5px;
          line-height: 1.65;
          letter-spacing: 0.01em;
        }
        .prose-bizzy p { margin: 0 0 10px; }
        .prose-bizzy strong { font-weight: 600; color: #FFFFFF; }
        .prose-bizzy em { color: #E6E7EA; }
        .prose-bizzy a { color: #B3E5FF; text-decoration: none; }
        .prose-bizzy a:hover { text-decoration: underline; }

        .prose-bizzy h1, .prose-bizzy h2, .prose-bizzy h3 {
          color: #FFFFFF;
          font-weight: 600;
          letter-spacing: 0.005em;
          margin: 12px 0 8px;
        }
        .prose-bizzy h1 { font-size: 20px; }
        .prose-bizzy h2 { font-size: 18px; }
        .prose-bizzy h3 { font-size: 16px; }

        .prose-bizzy ul, .prose-bizzy ol { margin: 8px 0 10px 18px; }
        .prose-bizzy li { margin: 4px 0; }

        .prose-bizzy blockquote {
          margin: 10px 0;
          padding: 8px 12px;
          border-left: 3px solid rgba(255,255,255,0.14);
          background: rgba(255,255,255,0.04);
          color: #EAECEF;
        }

        .prose-bizzy code {
          background: rgba(255,255,255,0.06);
          border: 1px solid rgba(255,255,255,0.12);
          padding: 1px 5px;
          border-radius: 6px;
          font-size: 13px;
        }
        .prose-bizzy pre code {
          display: block;
          padding: 10px 12px;
          border-radius: 10px;
          line-height: 1.55;
        }

        .prose-bizzy hr {
          border: 0;
          border-top: 1px solid rgba(255,255,255,0.08);
          margin: 12px 0;
        }
      `}</style>
    </div>
  );
}

import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkBreaksLite } from "./remarkBreaks.js";

export function normalizeAssistantMarkdown(raw = "") {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/\r/g, "")
    .replace(/\*\*([^*\n]+?):\s+\*\*(\S)/g, (_match, label, next) => `**${label}:** ${next}`)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

export function assistantMessageText(message = {}) {
  if (typeof message.text === "string") return message.text;
  if (typeof message.responseText === "string") return message.responseText;
  if (typeof message.content === "string") return message.content;
  return "";
}

const components = {
  strong: ({ children }) => React.createElement("strong", null, children),
  em: ({ children }) => React.createElement("em", null, children),
  a: ({ children, ...props }) => React.createElement("a", { ...props, target: "_blank", rel: "noopener noreferrer" }, children),
  table: ({ children }) => React.createElement("div", { className: "bizzy-table-scroll", role: "region", "aria-label": "Scrollable table", tabIndex: 0 }, React.createElement("table", null, children)),
};

const styles = `
.bizzy-assistant-content{color:#e5e7eb;font-size:15px;line-height:1.6;overflow-wrap:anywhere}.bizzy-assistant-content p{margin:0 0 10px}.bizzy-assistant-content strong{font-weight:600;color:#f8fafc}.bizzy-assistant-content em{color:#dce0e7}.bizzy-assistant-content a{color:#bae6fd}.bizzy-assistant-content ul{margin:8px 0 12px;padding-left:18px;list-style:disc}.bizzy-assistant-content ol{margin:8px 0 12px;padding-left:18px;list-style:decimal}.bizzy-assistant-content li{margin:2px 0}.bizzy-assistant-content code{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);padding:2px 6px;border-radius:6px;font-size:13px}.bizzy-assistant-partial{white-space:pre-wrap}.bizzy-table-scroll{display:block;width:100%;max-width:100%;margin:10px 0 14px;overflow-x:auto;overscroll-behavior-inline:contain;-webkit-overflow-scrolling:touch}.bizzy-table-scroll table{width:100%;min-width:620px;border-collapse:collapse;text-align:left}.bizzy-table-scroll th{color:#f8fafc;font-weight:600;border-bottom:1px solid rgba(255,255,255,.18)}.bizzy-table-scroll th,.bizzy-table-scroll td{padding:9px 10px;vertical-align:top}.bizzy-table-scroll td{border-bottom:1px solid rgba(255,255,255,.09)}.bizzy-table-scroll tr:last-child td{border-bottom:0}
`;

export default function AssistantMessageContent({ message, text, complete = true, className = "" } = {}) {
  const content = normalizeAssistantMarkdown(typeof text === "string" ? text : assistantMessageText(message));
  const body = complete
    ? React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm, remarkBreaksLite], components }, content)
    : content;
  return React.createElement(
    "div",
    { className: `bizzy-assistant-content ${complete ? "" : "bizzy-assistant-partial"} ${className}`.trim(), "data-markdown-complete": String(complete) },
    body,
    React.createElement("style", null, styles),
  );
}

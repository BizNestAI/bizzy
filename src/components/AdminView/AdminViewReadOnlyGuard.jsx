import { useEffect } from "react";
import { useAdminView } from "../../context/AdminViewContext.jsx";

const MUTATION_LABEL_RE =
  /\b(approve|post|retry|save|generate|connect|disconnect|relink|sync|create|delete|remove|submit|send|mark sent|convert|dismiss|reopen|void|archive|edit|update)\b/i;
const SAFE_LABEL_RE = /\b(return to monthly review|exit admin view|refresh|retry loading|close|cancel|back|search|view|open|download|export)\b/i;

export function isAdminViewMutationControl(element) {
  if (!element) return false;
  const tag = String(element.tagName || "").toLowerCase();
  if (!["button", "input"].includes(tag)) return false;
  const type = String(element.getAttribute("type") || (tag === "button" ? "button" : "")).toLowerCase();
  if (tag === "input" && !["button", "submit"].includes(type)) return false;
  const label = [
    element.textContent,
    element.getAttribute("aria-label"),
    element.getAttribute("title"),
    element.value,
    element.name,
    element.id,
  ].filter(Boolean).join(" ");
  if (!label || SAFE_LABEL_RE.test(label)) return false;
  return MUTATION_LABEL_RE.test(label);
}

export default function AdminViewReadOnlyGuard() {
  const adminView = useAdminView();

  useEffect(() => {
    if (!adminView.active || !adminView.readOnly || typeof document === "undefined") return undefined;

    const disabled = new WeakMap();
    const apply = () => {
      document.querySelectorAll(".bizzy-app-shell main button, .bizzy-app-shell main input[type='button'], .bizzy-app-shell main input[type='submit']").forEach((element) => {
        if (!isAdminViewMutationControl(element)) return;
        if (!disabled.has(element)) {
          disabled.set(element, {
            disabled: element.disabled,
            title: element.getAttribute("title"),
          });
        }
        element.disabled = true;
        element.setAttribute("aria-disabled", "true");
        element.setAttribute("data-admin-view-read-only", "true");
        element.setAttribute("title", "Read-only Admin View blocks customer mutations.");
      });
    };

    const block = (event) => {
      const target = event.target?.closest?.("button,input[type='button'],input[type='submit']");
      if (!target || !target.matches?.(".bizzy-app-shell main *")) return;
      if (!isAdminViewMutationControl(target)) return;
      event.preventDefault();
      event.stopPropagation();
    };

    apply();
    document.addEventListener("click", block, true);
    document.addEventListener("submit", block, true);
    const observer = new MutationObserver(apply);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      document.removeEventListener("click", block, true);
      document.removeEventListener("submit", block, true);
      observer.disconnect();
      document.querySelectorAll("[data-admin-view-read-only='true']").forEach((element) => {
        const previous = disabled.get(element);
        if (!previous) return;
        element.disabled = previous.disabled;
        if (previous.title == null) element.removeAttribute("title");
        else element.setAttribute("title", previous.title);
        element.removeAttribute("aria-disabled");
        element.removeAttribute("data-admin-view-read-only");
      });
    };
  }, [adminView.active, adminView.readOnly]);

  return null;
}

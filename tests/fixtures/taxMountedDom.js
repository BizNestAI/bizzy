class EventTargetStub {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) { const set = this.listeners.get(type) || new Set(); set.add(listener); this.listeners.set(type, set); }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatchEvent(event) { event.target ||= this; event.currentTarget = this; for (const listener of this.listeners.get(event.type) || []) listener.call(this, event); return true; }
}
class NodeStub extends EventTargetStub {
  constructor(type, name, document = null) { super(); this.nodeType = type; this.nodeName = name; this.ownerDocument = document; this.parentNode = null; this.childNodes = []; }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes.at(-1) || null; }
  appendChild(child) { return this.insertBefore(child, null); }
  insertBefore(child, before) { child.parentNode?.removeChild?.(child); const index = before ? this.childNodes.indexOf(before) : -1; if (index < 0) this.childNodes.push(child); else this.childNodes.splice(index, 0, child); child.parentNode = this; return child; }
  removeChild(child) { const index = this.childNodes.indexOf(child); if (index >= 0) this.childNodes.splice(index, 1); child.parentNode = null; return child; }
  get textContent() { return this.nodeType === 3 ? this.nodeValue || "" : this.childNodes.map((child) => child.textContent).join(""); }
  set textContent(value) { this.childNodes = []; if (value && this.ownerDocument) this.appendChild(this.ownerDocument.createTextNode(String(value))); }
  dispatchEvent(event) { super.dispatchEvent(event); if (event.bubbles !== false) this.parentNode?.dispatchEvent?.(event); return true; }
}
class ElementStub extends NodeStub {
  constructor(name, document) { super(1, String(name).toUpperCase(), document); this.tagName = this.nodeName; this.namespaceURI = "http://www.w3.org/1999/xhtml"; this.attributes = new Map(); this.style = { setProperty() {}, removeProperty() {} }; this.dataset = {}; }
  get options() { return this.childNodes.filter((child) => child.tagName === "OPTION"); }
  get value() { return this._value ?? this.attributes.get("value") ?? ""; }
  set value(value) { this._value = String(value); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  contains(node) { return node === this || this.childNodes.some((child) => child.contains?.(node)); }
  focus() { this.ownerDocument.activeElement = this; }
  blur() {}
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  click() { this.dispatchEvent({ type: "click", bubbles: true, preventDefault() {}, stopPropagation() { this.bubbles = false; } }); }
}

function installDom() {
  const window = new EventTargetStub();
  const document = new NodeStub(9, "#document");
  document.defaultView = window;
  document.createElement = (name) => new ElementStub(name, document);
  document.createElementNS = (_ns, name) => new ElementStub(name, document);
  document.createTextNode = (value) => Object.assign(new NodeStub(3, "#text", document), { nodeValue: String(value) });
  document.documentElement = document.createElement("html"); document.body = document.createElement("body"); document.appendChild(document.documentElement); document.documentElement.appendChild(document.body);
  const container = document.createElement("div"); document.body.appendChild(container);
  Object.assign(window, { innerWidth: 1440, innerHeight: 900, document, location: new URL("https://app.bizzios.com/dashboard/tax"), HTMLElement: ElementStub, HTMLIFrameElement: class extends ElementStub {}, SVGElement: ElementStub, Element: ElementStub, Node: NodeStub, getComputedStyle: () => ({ getPropertyValue: () => "", overflow: "visible" }), requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), setTimeout, clearTimeout, scrollTo() {} });
  Object.assign(globalThis, { window, document, HTMLElement: ElementStub, HTMLIFrameElement: window.HTMLIFrameElement, SVGElement: ElementStub, Element: ElementStub, Node: NodeStub, IS_REACT_ACT_ENVIRONMENT: true, CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; this.bubbles = false; } } });
  return container;
}

function elements(root, predicate, output = []) { for (const child of root.childNodes || []) { if (child.nodeType === 1 && predicate(child)) output.push(child); elements(child, predicate, output); } return output; }
function button(root, label) { return elements(root, (node) => node.tagName === "BUTTON" && node.textContent.trim() === label)[0]; }


export { installDom, elements, button };

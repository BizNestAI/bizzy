import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = readFileSync(join(root, "src/layout/DashboardLayout.jsx"), "utf8");
const cssSource = readFileSync(join(root, "src/index.css"), "utf8");

function indexOfOrFail(needle) {
  const index = source.indexOf(needle);
  assert.notEqual(index, -1, `Expected DashboardLayout.jsx to contain ${needle}`);
  return index;
}

test("DashboardContent initializes dock height state before effects read it", () => {
  const stateIndex = indexOfOrFail("const [barHeight, setBarHeight] = useState(DEFAULT_BAR_HEIGHT)");
  const previousHeightRead = indexOfOrFail("preCanvasBarHeightRef.current = lastBarHeightRef.current || barHeight || DEFAULT_BAR_HEIGHT");
  const firstSetHeight = indexOfOrFail("setBarHeight(lastBarHeightRef.current)");

  assert.ok(stateIndex < previousHeightRead, "barHeight must be initialized before it is read by the canvas transition effect.");
  assert.ok(stateIndex < firstSetHeight, "setBarHeight must be initialized before any effect can call it.");
});

test("dock height measurement has safe defaults and guards missing browser APIs", () => {
  assert.match(source, /useState\(DEFAULT_BAR_HEIGHT\)/);
  assert.match(source, /Number\.isFinite\(numericHeight\)/);
  assert.match(source, /numericHeight <= 0/);
  assert.match(source, /typeof ResizeObserver === "undefined"/);
  assert.match(source, /return \(\) => ro\.disconnect\(\)/);
});

test("workspace and conversation widths remain separate after dock fix", () => {
  assert.match(cssSource, /--workspace-max-width:\s*1180px/);
  assert.match(source, /bizzy-page-width--conversation/);
  assert.match(source, /bizzy-page-width--workspace/);
  assert.match(source, /data-chat-center-col/);
  assert.match(source, /width: `min\(\$\{CHAT_CONTENT_VW \* 100\}vw, \$\{CHAT_MAX_W\}px\)`/);
});

test("workspace dock backdrop spans the main app area while the chat bar remains constrained", () => {
  assert.match(source, /className="hidden md:block fixed bottom-0 right-0 pointer-events-none"/);
  assert.match(source, /left: `\$\{bandLeft\}px`/);
  assert.match(source, /maxWidth: `\$\{CHAT_MAX_W\}px`/);
  assert.match(source, /height: `\$\{curtainH\}px`/);
  assert.match(source, /linear-gradient\(180deg, rgba\(5,6,6,0\), rgba\(5,6,6,0\.96\) 12px, var\(--bg\) 34px, var\(--bg\) 100%\)/);
});

test("DashboardLayout has a route-level error boundary around DashboardContent", () => {
  const boundaryIndex = indexOfOrFail("class DashboardRouteErrorBoundary extends React.Component");
  const usageIndex = indexOfOrFail("<DashboardRouteErrorBoundary>");
  const contentIndex = indexOfOrFail("<DashboardContent>{children}</DashboardContent>");

  assert.ok(boundaryIndex < usageIndex, "Boundary must be declared before use.");
  assert.ok(usageIndex < contentIndex, "Boundary must wrap DashboardContent.");
  assert.match(source, /Your data was not changed/);
  assert.doesNotMatch(source, /error\.stack|componentStack/);
});

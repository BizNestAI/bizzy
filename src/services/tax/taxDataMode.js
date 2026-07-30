import { shouldUseDemoData } from "../demo/demoClient.js";

export const TAX_DATA_MODES = Object.freeze({
  LIVE: "live",
  DEMO: "demo",
  DISABLED: "disabled",
});

export function resolveTaxDataMode({ businessId, appDemoState } = {}) {
  if (appDemoState === true || appDemoState === TAX_DATA_MODES.DEMO) return TAX_DATA_MODES.DEMO;
  if (appDemoState === TAX_DATA_MODES.LIVE) return businessId ? TAX_DATA_MODES.LIVE : TAX_DATA_MODES.DISABLED;
  if (shouldUseDemoData(appDemoState)) return TAX_DATA_MODES.DEMO;
  if (!businessId) return TAX_DATA_MODES.DISABLED;
  return TAX_DATA_MODES.LIVE;
}

export function isDemoTaxMode(mode) {
  return mode === TAX_DATA_MODES.DEMO;
}

export default resolveTaxDataMode;

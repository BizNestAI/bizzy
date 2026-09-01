export function formatCurrencyTick(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  const sign = number < 0 ? "-" : "";
  const abs = Math.abs(number);
  if (abs >= 1_000_000) return `${sign}$${trimFixed(abs / 1_000_000)}M`;
  if (abs >= 1_000) return `${sign}$${trimFixed(abs / 1_000)}K`;
  return `${sign}$${Math.round(abs).toLocaleString()}`;
}

export function buildCurrencyAxis(values = [], {
  includeZero = true,
  minAtZero = false,
  tickCount = 5,
  headroom = 0.15,
} = {}) {
  const finite = values.map(Number).filter(Number.isFinite);
  if (!finite.length) {
    return { domain: [0, 1], ticks: [0, 0.25, 0.5, 0.75, 1] };
  }

  let min = Math.min(...finite);
  let max = Math.max(...finite);
  if (includeZero) {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }
  if (minAtZero && min >= 0) min = 0;

  if (min === max) {
    const spread = Math.max(Math.abs(max), 1);
    min = minAtZero || max >= 0 ? 0 : min - spread * headroom;
    max = max + spread * headroom;
  } else {
    const spread = max - min;
    if (!minAtZero || min < 0) min -= spread * headroom;
    max += spread * headroom;
    if (includeZero) {
      min = Math.min(min, 0);
      max = Math.max(max, 0);
    }
    if (minAtZero && min >= 0) min = 0;
  }

  const intervals = Math.max(2, Number(tickCount) || 5) - 1;
  const step = niceStep((max - min) / intervals);
  const axisMin = minAtZero && min >= 0 ? 0 : Math.floor(min / step) * step;
  const axisMax = Math.ceil(max / step) * step;
  const ticks = [];
  for (let tick = axisMin; tick <= axisMax + step / 2; tick += step) {
    ticks.push(roundTick(tick));
  }
  if (includeZero && !ticks.some((tick) => Math.abs(tick) < 1e-9)) {
    ticks.push(0);
    ticks.sort((a, b) => a - b);
  }
  return { domain: [ticks[0], ticks[ticks.length - 1]], ticks: uniqueFormattedTicks(ticks) };
}

function niceStep(rawStep) {
  const value = Math.max(Math.abs(Number(rawStep) || 0), 1);
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const nice =
    normalized <= 1 ? 1 :
    normalized <= 2 ? 2 :
    normalized <= 2.5 ? 2.5 :
    normalized <= 5 ? 5 :
    10;
  return nice * magnitude;
}

function roundTick(value) {
  return Math.abs(value) < 1e-9 ? 0 : Math.round(value * 100) / 100;
}

function trimFixed(value) {
  const rounded = Math.round(value * 100) / 100;
  return rounded.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

function uniqueFormattedTicks(ticks) {
  const seen = new Set();
  return ticks.filter((tick) => {
    const label = formatCurrencyTick(tick);
    if (seen.has(label)) return false;
    seen.add(label);
    return true;
  });
}

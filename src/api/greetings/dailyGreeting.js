const FALLBACK = "Morning, legend. Let's make this week count.";

const LINES = [
  "Morning, legend. Let's make this week count.",
  "Fresh pot, clear head, clean slate—let's get after it.",
  "Still early enough to change the whole tone of the week.",
  "Dial in the top priority, then let momentum carry the rest.",
  "Today’s the day you tighten every loose screw.",
  "It’s quiet. Perfect time to move first.",
  "Stack one more win before the competition wakes up.",
  "Let’s keep the pipeline warm and the cash steady.",
  "No noise, no drama—just sharp execution today.",
  "You already know the lever to pull. Let’s move it.",
  "Control the controllables. Everything else follows.",
  "Small consistent actions beat heroic catch-up every time.",
];

function seededRandom(seed) {
  let x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

export function getDailyGreeting(date = new Date()) {
  try {
    const stamp =
      typeof date === "string" ? date : date?.toISOString?.() || new Date().toISOString();
    const daySeed = Math.floor(new Date(stamp).setHours(0, 0, 0, 0) / 86400000);
    const idx = Math.floor(seededRandom(daySeed) * LINES.length);
    return LINES[idx] || FALLBACK;
  } catch {
    return FALLBACK;
  }
}

export function listDailyGreetings() {
  return LINES.slice();
}

export default getDailyGreeting;

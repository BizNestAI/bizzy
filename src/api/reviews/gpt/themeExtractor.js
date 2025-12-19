const DICT = {
  cleanup: ['clean','cleanup','debris','trash','mess'],
  communication: ['communicat','update','respond','response','call back','texted','emailed'],
  punctuality: ['late','on time','timely','schedule','delay'],
  quality: ['quality','craft','workmanship','finish','paint','leak','fix'],
  price: ['price','cost','expensive','cheap','quote','estimate'],
};
export function extractThemesDeterministic(text = '') {
  const t = text.toLowerCase(); const out = new Set();
  for (const [theme, keys] of Object.entries(DICT)) {
    if (keys.some(k => t.includes(k))) out.add(theme);
  }
  return Array.from(out);
}


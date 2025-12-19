export const nowUtc = () => new Date().toISOString();
export const rangeToDates = (range = '30d') => {
  const days = range === '90d' ? 90 : range === '365d' ? 365 : 30;
  const end = new Date();
  const start = new Date(); start.setDate(end.getDate() - days);
  return { start: start.toISOString(), end: end.toISOString() };
};

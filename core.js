// Pure date and math helpers. No storage or page code here.
(function (root) {
  const SETTER_METRICS = [
    { id: 'partnersContacted', label: 'Partners contacted', group: 'Partners', def: 'You personally asked someone to be a partner. Count each person once a week.' },
    { id: 'partnersSigned', label: 'New partners signed', group: 'Partners', def: 'They signed the Kept partner agreement.' },
    { id: 'intros', label: 'Partner intros', group: 'Partners', def: "One of your partners warmly connected you to an owner, or the person over benefits or payroll. Intros from your own network don't count here." },
    { id: 'outreach', label: 'Outreach', group: 'Deals', def: 'A knock. Any call, text, email or DM to an owner or the person over benefits.' },
    { id: 'contacts', label: 'Contacts', group: 'Deals', def: 'The door opened. You spoke to a decision maker and pitched for a meeting.' },
    { id: 'meetingsBooked', label: 'Meetings booked', group: 'Deals', def: 'A set. They agreed to a time.' },
    { id: 'meetingsSat', label: 'Meetings sat', group: 'Deals', def: 'A sit. The meeting actually happened.' },
  ];
  const CLOSER_METRICS = [
    { id: 'closerSat', label: 'Meetings sat/presented', group: 'Closing', def: 'You ran the meeting with the decision maker.' },
    { id: 'censuses', label: 'Censuses collected', group: 'Closing', def: 'One per business, once you have the full employee list. Just tap. The file never goes in here.' },
    { id: 'signedDeals', label: 'Signed deals', group: 'Closing', def: 'One per business, when the employer signs.' },
  ];
  const CLOSER_RATES = [
    { id: 'rateCensus', label: 'Sat → census', from: 'closerSat', to: 'censuses' },
    { id: 'rateSigned', label: 'Census → signed', from: 'censuses', to: 'signedDeals' },
    { id: 'rateClose', label: 'Sat → signed', from: 'closerSat', to: 'signedDeals' },
  ];

  const DEALS_RULE = 'Every deal runs through Outreach, Contact, Booked and Sat, wherever it came from. If a partner sent it, also tap Partner intros once.';

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => String(n).padStart(2, '0');
  const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (k, n) => { const [y, m, d] = k.split('-').map(Number); return dateKey(new Date(y, m - 1, d + n)); };
  const weekStart = (k) => addDays(k, -((parseKey(k).getDay() + 6) % 7));
  const monthStart = (k) => k.slice(0, 8) + '01';
  const short = (k) => { const d = parseKey(k); return `${MONTHS[d.getMonth()]} ${d.getDate()}`; };
  const monthName = (k) => MONTHS[parseKey(k).getMonth()];

  // Weeks are labelled Mon to Fri, but weekend taps count toward that same week.
  function weekLabel(start) {
    const end = addDays(start, 4);
    const a = parseKey(start), b = parseKey(end);
    return a.getMonth() === b.getMonth()
      ? `${MONTHS[a.getMonth()]} ${a.getDate()}–${b.getDate()}`
      : `${MONTHS[a.getMonth()]} ${a.getDate()}–${MONTHS[b.getMonth()]} ${b.getDate()}`;
  }

  function periodRange(kind, today) {
    if (kind === 'week') { const s = weekStart(today); return [s, addDays(s, 6)]; }
    if (kind === 'mtd') return [monthStart(today), today];
    return ['0000-01-01', '9999-12-31'];
  }

  // Adds up one person's numbers between two dates, inclusive.
  function sumRange(personCounts, from, to) {
    const out = {};
    for (const day of Object.keys(personCounts || {})) {
      if (day < from || day > to) continue;
      for (const [m, n] of Object.entries(personCounts[day])) out[m] = (out[m] || 0) + n;
    }
    return out;
  }

  function addInto(total, part) {
    for (const [m, n] of Object.entries(part)) total[m] = (total[m] || 0) + n;
    return total;
  }

  function rate(values, r) {
    const from = values[r.from] || 0;
    return from === 0 ? null : (values[r.to] || 0) / from;
  }

  function firstDay(allCounts) {
    let first = null;
    for (const days of Object.values(allCounts)) {
      for (const d of Object.keys(days)) if (!first || d < first) first = d;
    }
    return first;
  }

  // Every week from the first logged day to the current week, newest first.
  function weeksThrough(today, first) {
    const out = [];
    let w = weekStart(today);
    const stop = weekStart(first || today);
    while (w >= stop) { out.push(w); w = addDays(w, -7); }
    return out;
  }

  // A plus lands on today. A minus undoes the most recent tap in the current week,
  // so a Monday mistake can still be fixed on Wednesday.
  function bump(personCounts, metric, delta, today) {
    const days = personCounts;
    if (delta > 0) {
      days[today] = days[today] || {};
      days[today][metric] = (days[today][metric] || 0) + delta;
      return true;
    }
    const start = weekStart(today);
    const end = addDays(start, 6);
    const candidates = Object.keys(days).filter((d) => d >= start && d <= end && (days[d][metric] || 0) > 0).sort().reverse();
    if (!candidates.length) return false;
    const d = candidates[0];
    days[d][metric] -= 1;
    if (days[d][metric] === 0) delete days[d][metric];
    if (Object.keys(days[d]).length === 0) delete days[d];
    return true;
  }

  const api = { SETTER_METRICS, CLOSER_METRICS, CLOSER_RATES, DEALS_RULE, dateKey, parseKey, addDays, weekStart, monthStart, short, monthName, weekLabel, periodRange, sumRange, addInto, rate, firstDay, weeksThrough, bump };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Core = api;
})(typeof window !== 'undefined' ? window : globalThis);

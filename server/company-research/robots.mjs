export const RESEARCH_USER_AGENT = 'CompanyDeepResearch/2.0';
export function robotsAllowed(text, input) {
  const groups = []; let current = { agents: [], rules: [] };
  for (const line of String(text).slice(0, 100000).split(/\r?\n/)) {
    const match = line.split('#')[0].trim().match(/^(user-agent|allow|disallow)\s*:\s*(.*)$/i);
    if (!match) continue;
    const [, rawKey, rawValue] = match, key = rawKey.toLowerCase(), value = rawValue.trim();
    if (key === 'user-agent') {
      if (current.rules.length) { groups.push(current); current = { agents: [], rules: [] }; }
      current.agents.push(value.toLowerCase());
    } else if (value && value.length <= 500 && current.rules.length < 1000) current.rules.push({ allow: key === 'allow', path: value });
  }
  groups.push(current);
  const agent = RESEARCH_USER_AGENT.toLowerCase();
  const specific = groups.filter(g => g.agents.some(a => a !== '*' && agent.startsWith(a)));
  const chosen = specific.length ? specific : groups.filter(g => g.agents.includes('*'));
  const url = new URL(input), target = url.pathname + url.search;
  const matches = chosen.flatMap(g => g.rules).filter(r => {
    const end = r.path.endsWith('$');
    const path = end ? r.path.slice(0, -1) : r.path;
    const expression = path.split('*').map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return new RegExp(`^${expression}${end ? '$' : ''}`).test(target);
  }).sort((a, b) => b.path.replace(/[*$]/g, '').length - a.path.replace(/[*$]/g, '').length || Number(b.allow) - Number(a.allow));
  return !matches.length || matches[0].allow;
}

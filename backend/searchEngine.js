const MAX_QUERY = 80;
const MAX_TOKENS = 8;

function text(v) {
  return v == null ? '' : String(v);
}

function tokenize(q) {
  const raw = text(q).trim().slice(0, MAX_QUERY).toLowerCase();
  if (!raw) return [];
  return raw.split(/\s+/).filter(Boolean).slice(0, MAX_TOKENS);
}

function fieldText(v) {
  return text(v).toLowerCase();
}

function matches(tokens, fields) {
  if (!tokens || !tokens.length) return false;
  const haystacks = (fields || []).map(fieldText);
  return tokens.every((token) => haystacks.some((h) => h.includes(token)));
}

function rank(tokens, titleFields, extraFields) {
  if (!tokens || !tokens.length) return 0;
  const titles = (titleFields || []).map(fieldText);
  const extras = (extraFields || []).map(fieldText);
  let score = 0;
  for (const token of tokens) {
    if (titles.some((h) => h.includes(token))) score += 3;
    else if (extras.some((h) => h.includes(token))) score += 1;
  }
  return score;
}

function parseSearchQuery(raw) {
  const trimmed = text(raw).trim().slice(0, MAX_QUERY);
  return { raw: trimmed, tokens: tokenize(trimmed) };
}

function searchGroup({ type, label, rows, tokens, limit, titleFields, extraFields, toItem }) {
  const scored = [];
  for (const row of rows) {
    const titles = titleFields(row);
    const extras = extraFields ? extraFields(row) : [];
    if (!matches(tokens, titles.concat(extras))) continue;
    scored.push({
      score: rank(tokens, titles, extras),
      id: row.id,
      item: toItem(row),
    });
  }
  scored.sort((a, b) => (b.score - a.score) || (b.id - a.id));
  return {
    type,
    label,
    total: scored.length,
    items: scored.slice(0, limit).map((x) => x.item),
  };
}

module.exports = {
  MAX_QUERY,
  MAX_TOKENS,
  tokenize,
  matches,
  rank,
  parseSearchQuery,
  searchGroup,
};

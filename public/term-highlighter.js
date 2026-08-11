function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[character]);
}

function occurrences(text, phrase) {
  const indexes = [];
  if (!phrase) return indexes;
  let index = 0;
  while ((index = text.indexOf(phrase, index)) >= 0) {
    indexes.push(index);
    index += phrase.length;
  }
  return indexes;
}

export function renderTranslationMarkup(translation, matches = [], suggestions = []) {
  const text = String(translation ?? "");
  const marks = [];
  const targetSources = new Map();
  for (const match of matches) {
    const target = String(match?.term?.target || "").trim();
    const source = String(match?.term?.source || "").trim();
    if (!target) continue;
    const sources = targetSources.get(target) || new Set();
    if (source) sources.add(source);
    targetSources.set(target, sources);
  }
  for (const [target, sources] of targetSources) {
    for (const start of occurrences(text, target)) marks.push({ type: "official", start, end: start + target.length, text: target, sources: [...sources], priority: 2 });
  }
  for (const suggestion of suggestions) {
    const currentText = String(suggestion.currentText || "").trim();
    if (!currentText || currentText === suggestion.replacement) continue;
    for (const start of occurrences(text, currentText)) marks.push({ type: "suggestion", start, end: start + currentText.length, text: currentText, suggestion, priority: 1 });
  }
  marks.sort((a, b) => b.priority - a.priority || (b.end - b.start) - (a.end - a.start) || a.start - b.start);
  const selected = [];
  for (const mark of marks) {
    if (selected.some((current) => mark.start < current.end && mark.end > current.start)) continue;
    selected.push(mark);
  }
  selected.sort((a, b) => a.start - b.start);

  let offset = 0;
  let officialCount = 0;
  let suggestionCount = 0;
  const chunks = [];
  for (const mark of selected) {
    chunks.push(escapeHtml(text.slice(offset, mark.start)));
    if (mark.type === "official") {
      officialCount += 1;
      const label = mark.sources.length ? `术语库命中：${mark.sources.join(" / ")} → ${mark.text}` : `术语库命中：${mark.text}`;
      chunks.push(`<span class="term-highlight" title="${escapeHtml(label)}">${escapeHtml(mark.text)}</span>`);
    } else {
      suggestionCount += 1;
      const label = `疑似术语：${mark.text} → ${mark.suggestion.replacement}，点击查看替换`;
      chunks.push(`<button type="button" class="term-suggestion" data-suggestion-id="${escapeHtml(mark.suggestion.id)}" title="${escapeHtml(label)}">${escapeHtml(mark.text)}</button>`);
    }
    offset = mark.end;
  }
  chunks.push(escapeHtml(text.slice(offset)));
  return { html: chunks.join(""), officialCount, suggestionCount };
}

export function highlightTermMatches(translation, matches = []) {
  const rendered = renderTranslationMarkup(translation, matches, []);
  return { html: rendered.html, count: rendered.officialCount, terms: [...new Set(matches.map((match) => match?.term?.target).filter(Boolean))] };
}

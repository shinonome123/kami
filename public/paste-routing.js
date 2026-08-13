export function normalizePastedText(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").trim();
}

export function shouldRoutePasteToBatch(value) {
  return normalizePastedText(value).length > 0;
}

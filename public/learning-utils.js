export function learningEvaluationResult(evaluation) {
  const record = evaluation && typeof evaluation === "object" ? evaluation : {};
  return {
    ...record,
    ...(record.report && typeof record.report === "object" ? record.report : {}),
    ...(record.result && typeof record.result === "object" ? record.result : {})
  };
}

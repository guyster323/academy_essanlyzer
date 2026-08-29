async function postJson(path, payload) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    let message = `API 응답 오류 (status ${res.status})`;
    try {
      const body = await res.json();
      if (body && body.error) message = body.error;
    } catch (e) { /* non-JSON error body — keep default message */ }
    throw new Error(message);
  }
  return res.json();
}

export const detectIssuesApi = (payload) => postJson('/api/detect-issues', payload);
export const detectAnomalyApi = (payload) => postJson('/api/detect-anomaly', payload);
export const generateHypothesesApi = (payload) => postJson('/api/generate-hypotheses', payload);
export const draftReportApi = (payload) => postJson('/api/draft-report', payload);
export const comparePublishedApi = (payload) => postJson('/api/compare-published', payload);

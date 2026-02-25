export function getMetricsApiHeaders(): Record<string, string> {
  const token = process.env.METRICS_API_TOKEN?.trim();
  if (!token) {
    return {};
  }
  return {
    Authorization: `Bearer ${token}`
  };
}

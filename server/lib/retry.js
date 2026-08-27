/**
 * Runs `fn()`, and if it throws an error `shouldRetry` accepts, runs it one
 * more time before giving up. Used for exactly-once retry on a 502-class
 * failure (model response didn't validate, or the CLI/API call hiccuped) —
 * see routes/analysis.js.
 */
export async function retryOnce(fn, shouldRetry, onRetry) {
  try {
    return await fn();
  } catch (e) {
    if (shouldRetry(e)) {
      if (onRetry) onRetry(e);
      return await fn();
    }
    throw e;
  }
}

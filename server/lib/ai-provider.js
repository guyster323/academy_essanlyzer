import { callStructuredViaCli } from './claude-cli.js';
import { callStructured as callStructuredViaApi } from './anthropic.js';

/**
 * AI_PROVIDER=cli (default) — demo mode, no billing setup required: shells
 *   out to the locally-installed Claude Code CLI, reusing its existing
 *   subscription login. See claude-cli.js.
 * AI_PROVIDER=api — production mode: calls the metered Anthropic Messages
 *   API directly with ANTHROPIC_API_KEY. See anthropic.js.
 */
export async function callStructured({ system, prompt, tool, maxTokens }) {
  const provider = (process.env.AI_PROVIDER || 'cli').trim().toLowerCase();
  if (provider === 'api') {
    return callStructuredViaApi({ system, prompt, tool, maxTokens });
  }
  if (provider !== 'cli') {
    throw Object.assign(new Error(`알 수 없는 AI_PROVIDER 값: "${provider}" (cli 또는 api만 지원)`), { status: 500 });
  }
  // cli intentionally ignores maxTokens. Measured 2026-08-30
  // (Report/latency-findings.md): detect-anomaly thinking tokens were
  // 3,990–20,736 against the route's maxTokens: 2000. Thinking tokens
  // consume the same CLI output budget as the answer;
  // CLAUDE_CODE_MAX_OUTPUT_TOKENS=4000 previously returned is_error /
  // stop_reason:stop_sequence with no structured_output
  // (Report/latency-root-cause-and-plan.md case D). The CLI's own
  // maxOutputTokens is already 64k, which sits above observed thinking,
  // so wiring the route caps through would only recreate case D. This
  // omission is documented, not silent.
  return callStructuredViaCli({ system, prompt, tool });
}

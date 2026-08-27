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
  return callStructuredViaCli({ system, prompt, tool });
}

import Anthropic from '@anthropic-ai/sdk';

const REQUEST_TIMEOUT_MS = 60_000;

let client = null;
function getClient() {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      const err = new Error('ANTHROPIC_API_KEY가 설정되지 않았습니다 — .env 파일을 확인하세요.');
      err.status = 401;
      throw err;
    }
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

function classifyAnthropicError(e) {
  if (e instanceof Anthropic.AuthenticationError) {
    return Object.assign(new Error('Anthropic 인증 실패 — API 키를 확인하세요.'), { status: 401 });
  }
  if (e instanceof Anthropic.RateLimitError) {
    return Object.assign(new Error('Anthropic rate limit 초과 — 잠시 후 다시 시도하세요.'), { status: 429 });
  }
  if (e instanceof Anthropic.APIConnectionTimeoutError) {
    return Object.assign(new Error(`Anthropic 응답 시간 초과(${REQUEST_TIMEOUT_MS / 1000}초).`), { status: 504 });
  }
  if (e instanceof Anthropic.APIError) {
    return Object.assign(new Error(`Anthropic API 오류: ${e.message}`), { status: 502 });
  }
  return e; // unexpected — surfaces as 500
}

/**
 * Calls Claude with a forced tool-use call so the response is guaranteed to
 * match `tool.input_schema` — no free-text JSON parsing/regex extraction
 * needed. `tool` must have `strict: true` set (see lib/schemas.js) so
 * tool_use.input actually validates against the schema, not just that the
 * tool got called.
 */
export async function callStructured({ system, prompt, tool, maxTokens = 2000 }) {
  let res;
  try {
    res = await getClient().messages.create(
      {
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: prompt }],
        tools: [tool],
        tool_choice: { type: 'tool', name: tool.name }
      },
      { timeout: REQUEST_TIMEOUT_MS }
    );
  } catch (e) {
    throw classifyAnthropicError(e);
  }

  const block = res.content.find((b) => b.type === 'tool_use');
  if (!block) {
    throw Object.assign(new Error('모델이 구조화된 응답을 반환하지 않았습니다.'), { status: 502 });
  }
  return block.input;
}

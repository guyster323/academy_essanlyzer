import { spawn } from 'node:child_process';
import os from 'node:os';

/**
 * Demo/test AI provider: shells out to the locally-installed Claude Code
 * CLI (`claude -p`) instead of calling the metered Anthropic Messages API
 * with a separate paid API key. Reuses whatever `claude` auth is already on
 * this machine (Pro/Max/Team subscription login via `claude` — NOT a
 * pay-per-token API key), so a presenter can demo the full pipeline without
 * provisioning billing. See lib/anthropic.js for the API-key-backed path
 * (used when AI_PROVIDER=api) — that one incurs metered charges.
 *
 * The CLI's `--json-schema` flag gives the same structured-output guarantee
 * as the SDK's strict tool-use: the response includes a `structured_output`
 * field already validated against the schema we pass, so tool.input_schema
 * (from lib/schemas.js) is reused as-is — no separate schema needed.
 */

const CLI_BIN = process.env.CLAUDE_CLI_PATH || 'claude';
// Safety ceiling, not a performance target. Extended thinking dominates the
// wall-clock (87-94% of output tokens on every valid run) and there is no
// proven lever to cut it — see Report/latency-root-cause-and-plan.md.
// Measured detect-anomaly against the real stride80 prompt (54,738 chars,
// production CLI flags, Report/latency-effort-real-outputs/COMPARISON.md):
// 707.8s, 732.7s, 820.7s, 1139.8s. The slowest run left only ~60s under a
// 20-minute ceiling, and n=4 is too few to treat 1139.8s as the worst case,
// so this is 30 min — roughly 1.6x the slowest observed run. A too-low
// ceiling is the expensive failure here: it 504s after already burning the
// full think time. Overridable via CLAUDE_CLI_TIMEOUT_MS for CI/demo.
const CLI_TIMEOUT_MS = Number(process.env.CLAUDE_CLI_TIMEOUT_MS) || 1_800_000;
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

function runClaudeCli(args, stdinText) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(CLI_BIN, args, {
      // Run outside the project directory so the CLI doesn't auto-discover
      // this repo's CLAUDE.md/hooks/memory and pull them into the prompt —
      // we want a clean structured-output call, not a coding-agent session.
      cwd: os.tmpdir(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(Object.assign(new Error(`Claude CLI 응답 시간 초과(${CLI_TIMEOUT_MS / 1000}초).`), { status: 504 }));
    }, CLI_TIMEOUT_MS);

    child.stdout.on('data', (d) => {
      stdoutBytes += d.length;
      if (stdoutBytes <= MAX_OUTPUT_BYTES) stdout += d;
    });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const hint = e.code === 'ENOENT'
        ? ' — "claude" 실행 파일을 찾을 수 없습니다. Claude Code CLI가 설치·로그인되어 있는지 확인하세요.'
        : '';
      reject(Object.assign(new Error(`Claude CLI 실행 실패: ${e.message}${hint}`), { status: 502 }));
    });

    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr });
    });

    child.stdin.on('error', () => { /* ignore EPIPE if the process already exited */ });
    child.stdin.write(stdinText);
    child.stdin.end();
  });
}

// maxTokens is not accepted here. The cli path cannot safely honor the
// route-layer caps (1500/2000/4000): thinking tokens share the output
// budget and already exceed those caps (see ai-provider.js and
// Report/latency-findings.md). Do not add CLAUDE_CODE_MAX_OUTPUT_TOKENS
// without a measurement that still returns structured_output.
export async function callStructuredViaCli({ system, prompt, tool }) {
  const args = [
    '-p',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(tool.input_schema),
    '--model', process.env.ANTHROPIC_MODEL || 'sonnet',
    '--allowedTools', '',
    '--disable-slash-commands',
    // --effort is intentionally omitted. n=3 per low/medium/high on
    // 2026-08-30 (Report/latency-findings.md): within-level wall-clock
    // spread exceeded the between-level gap, and 7 of 9 runs returned
    // empty anomalyWindows. Side-by-side outputs for a human to judge
    // evidence-rigor fields are in Report/latency-effort-outputs/.
    // Skip user-global hooks/MCP/plugin sync and session persistence. Measured
    // on this machine: an equivalent structured call dropped from ~27s to ~6s
    // (cache-create of tens of thousands of tokens → cache-read). Do not use
    // --bare — it forces API-key-only auth and breaks the subscription/OAuth
    // login this project depends on. --safe-mode keeps auth and model selection.
    '--safe-mode',
    '--strict-mcp-config',
    '--no-session-persistence'
  ];
  if (system) args.push('--system-prompt', system);

  const { stdout, stderr } = await runClaudeCli(args, prompt);

  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch (e) {
    throw Object.assign(
      new Error(`Claude CLI 응답 파싱 실패${stderr ? `: ${stderr.slice(0, 300)}` : ''}`),
      { status: 502 }
    );
  }

  if (envelope.is_error || envelope.subtype !== 'success') {
    const apiStatus = Number.isInteger(envelope.api_error_status) ? envelope.api_error_status : null;
    const status = apiStatus === 401 ? 401 : apiStatus === 429 ? 429 : 502;
    throw Object.assign(
      new Error(`Claude CLI 오류(${envelope.subtype || 'unknown'}): ${envelope.result || '알 수 없는 오류'}`),
      { status }
    );
  }

  if (!envelope.structured_output) {
    throw Object.assign(new Error('Claude CLI가 구조화된 응답을 반환하지 않았습니다.'), { status: 502 });
  }

  return envelope.structured_output;
}

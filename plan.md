# ESS BMS 분석 워크스테이션 Review 후속 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 2026-08-26 1차 구현을 청사진의 사람 검토 원칙에 맞게 고치고, 개발/프로덕션 모두에서 재현 가능한 자동 테스트와 실제 Claude API 검증을 갖춘 PoC로 만든다.

**Architecture:** 브라우저는 원본 로그를 로컬에서 스트리밍 집계하고, Express 서버에는 크기가 제한된 통계·샘플·알람 컨텍스트만 전송한다. Express는 입력과 Claude 구조화 출력을 검증하고, 가설 선택·수정 및 심각도 확정은 반드시 사용자의 명시적 동작 뒤에만 보고서 생성으로 이어지게 한다.

**Tech Stack:** Vanilla JavaScript, Vite, Express, JSZip, Anthropic TypeScript SDK, Zod, Playwright

**Spec:** `LG MVP - PoC 청사진 - 시스템 이슈 분석 엔지니어.pdf`, `HANDOFF_TO_CLAUDE_CODE.md`, 기존 프로토타입 `ess_bms_analysis_workstation.html`

## Global Constraints

- 가설 방향 확정과 심각도 최종 판정은 AI가 자동 결정하지 않는다.
- 원본 로그 전체를 서버나 Claude에 보내지 않는다. 제한된 집계·샘플·알람 컨텍스트만 전송한다.
- 실 고객 데이터, 실제 설비명, 고객명, 사이트 위치, API 키를 커밋하지 않는다.
- 보고서 순서는 `Headline → 관측 사실 → 기술적 의미 → 판단/조치`를 유지한다.
- 이상 구간 또는 근거가 불충분하면 `추가 확인 필요`를 명시하고 다음 단계 자동 진행을 막는다.
- 개발·테스트에는 공개 데이터 또는 저장소의 가상 샘플만 사용한다.

---

## 1. 2026-08-26 Review 결론

### 판정

1차 구현은 파일 구조 분리, Express 프록시, npm JSZip, AEMO 포맷, 중첩 ZIP 카탈로그, 스트리밍 집계까지 상당 부분 구현됐다. `npm run build`와 JavaScript 구문 검사는 통과하며 프로덕션 번들에서는 모킹된 4단계 흐름이 끝까지 렌더링된다.

그러나 현재 상태는 다음 세 가지 P0 결함 때문에 청사진 기준의 시연 준비 완료로 볼 수 없다.

1. `npm run dev`에서 `/api.js`가 Vite의 `/api` 프록시에 가로채져 404가 되고, 입력 화면 전체가 비어 있다.
2. AI 가설 생성 직후 첫 가설과 심각도가 자동 선택되어 사람의 선택 없이 보고서 생성이 가능하다. 청사진의 필수 사람 검토 게이트를 우회한다.
3. Anthropic tool을 강제로 호출하지만 tool 정의에 `strict: true`가 없어 JSON Schema 준수를 보장하지 못한다.

### Review 범위와 증거

- 요구사항 PDF 9쪽 전체 텍스트 추출 및 페이지 렌더링 확인.
- `HANDOFF_TO_CLAUDE_CODE.md`, `README.md`, `plan.md`, 기존 단일 HTML, `src/`, `server/` 전체 정적 리뷰.
- `node --check`로 `src/`, `server/`의 JavaScript 13개 파일 모두 통과.
- `npm run build` 통과: Vite 5.4.21, JS 137.74 kB, CSS 18.43 kB.
- Playwright + Edge, 1440×900:
  - 개발 모드: `GET http://localhost:5173/api.js` 404, `#viewRoot` 패널 0개.
  - 프로덕션 모드: 샘플 입력 → 이상 구간 → 가설 → 보고서까지 모킹 API로 완료, 콘솔/페이지 오류 없음.
  - 사람 동작 전 상태: 선택된 가설 1개, 최종 심각도 `상`, 판정 근거 자동 입력, 보고서 버튼 활성화.
- Playwright + Edge, 390×844: 사이드바가 첫 화면 전체 높이를 차지해 실제 입력 본문이 아래로 밀림.
- 파서 재현:
  - `"hello,world"`가 한 셀이 아니라 두 셀로 분리됨.
  - 일반 `status=Charging` 행이 알람 1건으로 잘못 집계됨.
- `npm audit`: moderate 1건(`esbuild`), high 1건(`vite`), 총 2건.
- `npm audit --omit=dev`: production dependency 취약점 0건. 위 2건은 개발 도구 경로지만 로컬 dev server 노출 조건을 검토해야 한다.
- Anthropic 공식 문서 기준 `claude-sonnet-5` model ID는 유효하다. 반면 프로젝트 SDK `0.32.1`은 2026-08-26 npm registry 최신 `0.120.0`보다 크게 뒤처져 있다.
- Anthropic 공식 strict tool use 문서에 따르면 JSON Schema 보장은 tool 최상단의 `strict: true`가 필요하다: <https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use>
- 실제 Claude API 키 호출은 수행하지 못했다. `.env`의 키는 비어 있다.

### 요구사항 추적표

| 요구사항 | 상태 | Review 판단 |
|---|---|---|
| CS 의뢰 텍스트 입력·구조화 | 부분 충족 | 30자/timestamp 검증은 있으나 민감정보 탐지·재입력 안내가 없음 |
| CSV/TXT/LOG 및 ZIP 입력 | 부분 충족 | 대용량 스트리밍은 구현됐으나 표준 CSV 인용부호 파싱이 깨짐 |
| 이상 구간 탐지 | 부분 충족 | UI/API 구현, 실제 Claude 응답과 무이상 게이트 미검증 |
| 과거 PPTX/HTML 유사 보고서 참조 | 미충족 | 한 줄 텍스트 입력만 존재 |
| 원인 가설 2~3개 + 근거 | 부분 충족 | 스키마는 있으나 strict 미적용, 가설 직접 수정 불가 |
| 사람의 가설 선택·수정 | 미충족 | 첫 가설 자동 선택, 수정 UI 없음 |
| AI 심각도 초안과 사람 최종 판정 분리 | 미충족 | AI 초안이 최종 값으로 자동 복사됨 |
| 보고서·CS 메일 초안 | 부분 충족 | 생성·복사는 가능, 앱 내 수정/명시적 최종 검토 상태 없음 |
| 불충분 데이터 시 `추가 확인 필요` | 부분 충족 | 프롬프트 문구만 있고 단계 차단 규칙 없음 |
| 실 고객 정보 보호 | 부분 충족 | 경고 문구와 `.gitignore`만 있고 입력 검사·마스킹 없음 |
| 5~6시간 → 2~3시간 개선 | 미측정 | 실사용 시나리오 소요시간 측정이 없음 |

### 우선순위 Findings

#### P0 — 시연/핵심 원칙 차단

1. **개발 모드 흰 화면**
   - 원인: `vite.config.js`의 proxy key `/api`가 API endpoint뿐 아니라 `src/api.js` 모듈 요청도 매칭한다.
   - 증거: 브라우저에서 `/api.js` 404, `viewRootHtml=""`, panel count 0.
   - 영향: README의 기본 실행 명령 `npm run dev`로 앱을 사용할 수 없다.

2. **사람 검토 게이트 우회**
   - 원인: `src/pipeline.js:180-182`에서 첫 가설, 심각도, 판정 근거를 자동으로 최종 상태에 복사하고 `src/render.js:372`는 `selectedHypId`만으로 버튼을 활성화한다.
   - 증거: 가설 화면 진입 직후 radio 1개 checked, 심각도 `상`, 보고서 버튼 enabled. 아무 검토 동작 없이 `/api/draft-report` 호출 성공.
   - 영향: PDF와 HANDOFF의 핵심 안전장치 위반.

3. **구조화 응답 보장 오판**
   - 원인: `server/lib/schemas.js`의 tool 정의에 `strict: true`가 없다. forced `tool_choice`는 호출 여부만 강제하며 입력 스키마 준수는 보장하지 않는다.
   - 영향: 필수 필드 누락/타입 오류가 프런트 런타임 오류나 빈 보고서로 이어질 수 있다.

#### P1 — 정확도·안전·회귀 방지

4. `split(delimiter)` 기반 파서가 quoted delimiter/escaped quote를 지원하지 않는다.
5. `status` 컬럼의 정상 운전값 `Charging`, `Discharging`, `Idle` 등을 알람으로 오인할 수 있다.
6. 이상 구간이 0건이어도 가설 생성 버튼이 활성화되어 근거 없는 가설 생성을 허용한다.
7. 서버 요청 body와 Claude 응답에 런타임 검증이 없고, 모든 오류를 502로 반환하며 upstream 메시지를 그대로 노출한다.
8. 선택 가능한 파일/그룹 수에 대한 전체 프롬프트 예산이 없어 파일 수가 많으면 요청 크기가 계속 증가한다.
9. 자동 테스트가 없어서 빌드 성공이 UI/게이트/파서 정확성을 보증하지 않는다.
10. Vite 의존성에 high 1건, esbuild에 moderate 1건의 공개 취약점이 남아 있다. production dependency audit은 0건이지만 취약한 dev server를 그대로 사용하는 것은 피해야 한다.
11. 브라우저에 보이는 로그 샘플·알람 컨텍스트는 서버/Claude로 전송되므로, README의 “원본 로그는 브라우저를 벗어나지 않음”만으로는 민감정보 보호가 충분하지 않다.

#### P2 — 요구사항 완성도·사용성

12. PPTX/HTML 과거 보고서를 참조하는 경로가 없고 짧은 텍스트 필드만 있다.
13. 가설, 보고서, 메일을 앱 안에서 수정할 수 없다.
14. 390px 화면에서 고정 사이드바가 첫 화면을 차지한다.
15. 완료 케이스가 세션 메모리에만 남고 내보내기/복구 수단이 없다. 이는 현재 PoC 제약으로 허용하되 UI에서 더 명확히 표시한다.

---

## 2. 내일 실행 계획

### Task 1: 개발 모드 렌더링 복구 및 브라우저 회귀 테스트 기반

**Files:**
- Modify: `vite.config.js`
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `playwright.config.js`
- Create: `tests/e2e/app-load.spec.js`

**Interfaces:**
- Consumes: Vite의 `/api/*` 서버 프록시와 `src/api.js` 브라우저 모듈.
- Produces: `npm run test:e2e`, 개발 모드에서 첫 입력 패널이 보인다는 자동 회귀 검증.

- [x] **Step 1: Playwright 테스트 실행 기반 추가**

Run: `npm install -D @playwright/test@1.62.1`

`package.json`에 `"test:e2e": "playwright test"`를 추가하고, `playwright.config.js`는 `baseURL: 'http://localhost:5173'`, `webServer.command: 'npm run dev'`, `webServer.url: 'http://localhost:5173'`를 사용한다.

- [x] **Step 2: 실패하는 개발 모드 로드 테스트 작성**

```js
import { test, expect } from '@playwright/test';

test('development app renders the intake form without module 404s', async ({ page }) => {
  const failed = [];
  page.on('response', r => { if (r.status() >= 400) failed.push(r.url()); });
  await page.goto('/');
  await expect(page).toHaveTitle('ESS BMS 이슈 분석 워크스테이션');
  await expect(page.locator('#viewRoot .panel')).toHaveCount(1);
  await expect(page.getByRole('button', { name: /이상 구간 탐지 시작/ })).toBeVisible();
  expect(failed.filter(url => url.endsWith('/api.js'))).toEqual([]);
});
```

- [x] **Step 3: 테스트가 `/api.js` 404로 실패하는지 확인**

Run: `npm run test:e2e -- tests/e2e/app-load.spec.js`

Expected: FAIL, `#viewRoot .panel` count 0 또는 `/api.js` 404. → **재현 확인됨**: `[vite] http proxy error: /api.js`, `AggregateError [ECONNREFUSED]`, panel count 0.

- [x] **Step 4: API endpoint만 proxy하도록 matcher 축소**

`vite.config.js`의 proxy key를 `'/api'`에서 `'^/api/'` 정규식 matcher로 바꿈. `/api/detect-anomaly`는 proxy하고 `/api.js`는 Vite가 직접 제공.

- [x] **Step 5: 데스크톱·모바일 로드 테스트 통과 확인**

Run: `npx playwright test tests/e2e/app-load.spec.js` → **PASS** (desktop-chromium, mobile-chromium 모두), console/page error 0.

**구현 시 편차 (기록):** 브라우저는 Edge 대신 Playwright 기본 Chromium(1.62.1 번들)을 설치해 사용. `webServer.command`는 `npm run dev`(server+client) 대신 `npm run dev:client`(vite만)로 설정 — 이 테스트는 정적 로드만 검증하고 `/api/*` 실호출은 하지 않으므로 백엔드 기동이 불필요해 단순화함. 이후 `/api/*` 실호출을 검증하는 테스트를 추가할 때는 `webServer.command`를 `npm run dev`로 바꾸거나 별도 프로젝트 설정이 필요.

### Task 2: 사람 검토 게이트를 명시적 선택·수정·확정으로 변경

**Files:**
- Modify: `src/state.js`
- Modify: `src/pipeline.js`
- Modify: `src/render.js`
- Modify: `src/styles.css`
- Create: `tests/e2e/human-review.spec.js`

**Interfaces:**
- Consumes: `hypotheses[]`의 AI 초안과 `severityDraft`.
- Produces: `confirmedHypothesis` 객체, 사용자가 직접 선택한 `finalSeverity`, 비어 있지 않은 `finalSeverityReason`.

- [x] **Step 1: 사람 동작 전 보고서 생성이 불가능한 실패 테스트 작성** — `tests/e2e/human-review.spec.js` 4개 테스트, 수정 전 코드로 4개 모두 실패 확인(예상대로).

- [x] **Step 2: 가설 생성 완료 시 최종 상태를 비우도록 변경** — `runHypothesisGeneration()`에서 `selectedHypId/confirmedHypothesis/finalSeverity/finalSeverityReason` 모두 null/빈값으로 초기화.

- [x] **Step 3: 가설 직접 수정 UI 추가** — `selectHypothesis()`가 `confirmedHypothesis`에 편집 가능한 복사본 생성(원본 AI `hypotheses[]`는 불변), `startCustomHypothesis()`로 "AI 가설 대신 직접 작성" 가능. **단, plan 원안과 다르게 severityDraft/severityReason은 선택 시점에 finalSeverity로 자동 복사하지 않음** — Step 1 테스트가 "가설 선택 직후에도 severity 미설정이면 버튼 disabled"를 요구해서, 선택만으로 심각도까지 자동 채워지면 그 자체가 사람 확정 없는 자동완료가 되기 때문. AI 심각도 초안은 카드에 참고용으로만 표시.

- [x] **Step 4: 최종 심각도에 빈 placeholder를 추가하고 확인 조건 강화** — `isHumanReviewComplete()`(`src/state.js`)로 구현, 위치는 pipeline.js가 아니라 state.js(양쪽에서 순환 참조 없이 import하기 위함). `#sevSelect`/`#sevReasonInput`/`#confirmedHypName` 등은 항상 DOM에 존재하되 가설 미선택 시 `disabled`로 렌더 — Playwright의 `toHaveValue('')` 검증을 위해 필요했음. 버튼 disabled 상태는 전체 재렌더 대신 `refreshConfirmButtonState()`(`src/render.js`)로 부분 갱신해 입력 포커스 유지.

- [x] **Step 5: 보고서 요청이 수정된 가설과 명시적 최종 심각도를 사용하는지 확인**

Run: `npx playwright test tests/e2e/human-review.spec.js` → **6 passed, 4 skipped**(mobile — 사이드바가 390px에서 본문을 가리는 P2 #14, Task 8에서 처리 예정이라 desktop만 스코프).

### Task 3: Anthropic strict tool use와 양방향 런타임 검증

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `server/lib/schemas.js`
- Create: `server/lib/validation.js`
- Modify: `server/lib/anthropic.js`
- Modify: `server/routes/analysis.js`
- Create: `tests/server/validation.test.js`

**Interfaces:**
- Consumes: 각 endpoint request body, Claude `tool_use.input`.
- Produces: 스키마가 검증된 JSON 또는 상태 코드가 구분된 안전한 오류 객체 `{ error, code }`.

- [x] **Step 1: Zod와 통합 테스트 scripts 추가** — `npm install zod@4.4.3`. `test:unit`은 계획 원안(`node --test tests`)이 아니라 **`node --test`(인자 없음)**로 구현 — Node 24의 `--test`에 디렉터리를 위치 인자로 주면(`node --test tests/server`) 모듈로 `require` 시도하며 깨짐(`MODULE_NOT_FOUND`)을 확인했고, 인자 없이 실행하면 기본 glob(`**/*.test.js`)으로 정상 탐색되며 `tests/e2e/*.spec.js`(Playwright 전용 `test()`)는 확장자가 달라 자동으로 제외됨을 확인.

- [x] **Step 2: 잘못된 request/response가 거부되는 테스트 작성** — `tests/server/validation.test.js` 8개 케이스(계획에 명시된 6종 전부 + 유효 케이스 통과 확인 포함), 전부 PASS.

- [x] **Step 3: 모든 Anthropic tool에 strict mode 적용** — `claude-api` 스킬로 공식 문서 확인 후 구현: `strict:true`는 tool 객체 최상단(둘째 인자 아님), 모든 object 스키마에 `additionalProperties:false` + 완전한 `required` 배열. (기존 스키마는 이미 모든 필드가 required였어서 추가 변경 불요.)

- [x] **Step 4: Zod request schema와 response schema 추가** — `server/lib/validation.js`. `MAX_LOG_TEXT_CHARS=300000`, `MAX_ANOMALY_WINDOWS=200`을 export해 Task 5에서 프런트와 공유.

- [x] **Step 5: 오류 상태를 구분** — `server/lib/anthropic.js`에 `classifyAnthropicError()`(401/429/504/502), `routes/analysis.js`의 `wrap()`이 `ValidationError`(400)와 나머지를 구분해 상태 코드 매핑. 500 이상만 서버 콘솔에 로그.

- [x] **Step 6: 서버 테스트 통과 확인**

Run: `npm run test:unit` → **8 passed**. 추가로 실제 서버 기동 후 curl로 라이브 확인: `csText` 누락 요청 → **400**, API 키 미설정 상태에서 유효한 요청 → **401**(이전엔 502로 뭉뚱그려졌던 부분).

**미검증:** 실제 Anthropic API 키로 `strict:true` tool-use 호출 자체는 아직 라이브로 못 해봄 — SDK가 요청 바디에 `strict` 필드를 그대로 실어 보내는지, 실제로 스키마를 어긴 응답이 차단되는지는 Task 9에서 확인 필요.

### Task 4: CSV 파서와 알람 판정 정확도 보강

**Files:**
- Modify: `src/formats.js`
- Modify: `src/log-engine.js`
- Create: `tests/unit/formats.test.js`
- Create: `tests/unit/log-engine.test.js`

**Interfaces:**
- Produces: `parseDelimitedLine(line, delimiter): string[]`, 일반 상태와 실제 알람을 구분하는 adapter 규칙.

- [x] **Step 1: 현재 실패 사례를 테스트로 고정** — `tests/unit/formats.test.js`(9개) + `tests/unit/log-engine.test.js`(7개), 구현 전 `parseDelimitedLine` 미존재로 즉시 실패 확인.

- [x] **Step 2: quoted delimiter와 escaped quote를 처리하는 한 줄 parser 구현** — `src/formats.js`의 `parseDelimitedLine(line, delimiter)`, 문자 단위 state machine. 미종료 따옴표는 `null` 반환 → `log-engine.js`의 `feedLine`이 `acc.malformedRowCount`에 집계(행은 건너뜀, 조용히 오파싱하지 않음). `src.malformedRowCount`를 소스 목록 UI에 노출(계획에 없던 추가 — "silent truncation 금지" 기존 원칙과 일관되게 하기 위해 포함).

- [x] **Step 3: alarm/fault 컬럼을 status보다 우선하고 정상 status allowlist 적용** — `GENERIC_FORMAT.alarmColumnGuess`가 `/alarm|fault/i`를 `/status/i`보다 우선 매칭. `isAlarmValue(v, columnName)`이 매칭된 컬럼이 status-only인지에 따라 allowlist(`OK,NORMAL,CHARGING,DISCHARGING,IDLE,STANDBY,RUNNING,READY,0`) 적용 여부를 분기 — alarm/fault 코드 컬럼은 기존처럼 엄격한 규칙(0/OK/NORMAL 외 전부 알람) 유지. AEMO 포맷의 `MW_QUALITY_FLAG` 규칙은 무영향.

- [x] **Step 4: 단위 테스트 통과 및 공개 AEMO 샘플 회귀 확인**

Run: `node --test` → **23 passed**(신규 16개 + 기존 8개, `test:unit`에 흡수). 추가로 실제 `PUBLIC_NEXT_DAY_FPPMW_20250817.zip` 20만행 샘플로 재검증: BESS 필터 시 rowCount=7675, alarmCount=1707, 16개 그룹 — 파서 교체 전과 **완전히 동일**(회귀 없음). `npm run build` + Playwright 전체 재확인 PASS.

### Task 5: 근거 부족 게이트와 고정 프롬프트 예산

**Files:**
- Modify: `src/pipeline.js`
- Modify: `src/render.js`
- Modify: `server/lib/prompts.js`
- Modify: `server/lib/validation.js`
- Create: `tests/unit/prompt-budget.test.js`
- Modify: `tests/e2e/human-review.spec.js`

**Interfaces:**
- Produces: 제한된 `combinedLogText`, 표시 가능한 truncation metadata, 무이상 시 다음 단계 차단.

- [x] **Step 1: anomaly 0건이면 가설 생성 버튼이 비활성화되는 테스트 작성** — `tests/e2e/human-review.spec.js`에 추가, 고정 문구 `판단 불가 — 추가 확인 필요: 로그 범위, 임계값, 관련 PCS/EMS 로그를 확인하세요.` 표시 + 버튼 disabled 확인.

- [x] **Step 2: 프롬프트 예산을 상수로 정의** — `src/log-engine.js`: `MAX_SELECTED_SOURCES=10`, `MAX_GROUPS_PER_SOURCE_IN_PROMPT=10`(기존 `MAX_GROUPS_IN_PROMPT=30`에서 하향), `MAX_TOTAL_ALARM_CONTEXTS=60`(**요청 전체에 걸친 전역 예산** — 기존엔 블록/그룹별로 각각 15건씩 사실상 무제한 누적되던 것을 수정), `MAX_LOG_TEXT_CHARS=300000`. `server/lib/validation.js`의 동일 이름 상수와 값 일치(모듈이 달라 직접 import는 불가, 주석으로 동기화 명시).

- [x] **Step 3: 제한 초과 시 조용히 자르지 말고 사용자에게 알려주기** — `blocksToPromptText()`가 `truncation` 메타데이터 반환, ①소스 목록에 "선택 N개 중 최대 10개까지만 포함" 배너(제출 전에도 바로 보임), ②이상구간 화면에 실제 생략 내역(그룹/알람컨텍스트/문자수) 배너, ③프롬프트 본문 최상단에도 동일 요약을 넣어 AI가 부분 데이터를 완전한 것으로 오인하지 않도록 함.

- [x] **Step 4: 예산 테스트 통과 확인**

Run: `node --test` → **29 passed**(신규 6개 prompt-budget 포함). 실제 AEMO 데이터(BESS 필터, 16개 그룹)로 재검증: 프롬프트가 46.7KB로 축소, "엔티티 그룹 6개 상세 생략, 알람 컨텍스트 140건 생략" 정확히 보고됨. `npm run build` + Playwright 전체(7 passed / 5 skipped-mobile) 재확인.

### Task 6: 민감정보 방어와 과거 보고서 참조 입력

**Files:**
- Modify: `src/state.js`
- Create: `src/reference-docs.js`
- Modify: `src/render.js`
- Modify: `src/pipeline.js`
- Modify: `server/lib/prompts.js`
- Create: `tests/unit/reference-docs.test.js`
- Create: `tests/e2e/privacy.spec.js`

**Interfaces:**
- Consumes: 사용자가 명시적으로 선택한 redacted `.html`/`.pptx` 참고 파일.
- Produces: 파일당 최대 20,000자, 전체 최대 60,000자의 텍스트 발췌와 출처 파일명 목록.

- [x] **Step 1: 민감정보 확인 체크박스 없이 분석 시작을 막는 테스트 작성** — `tests/e2e/privacy.spec.js`,
  계획에 명시된 정확한 문구(`고객명·사이트 위치·실 설비 식별자·개인정보를 제거했음을 확인합니다.`)로 구현.
  구현 전 재현 확인(체크박스 없이 실패 3건) → 구현 후 PASS.

- [x] **Step 2: 명백한 패턴 탐지 시 재입력 안내** — `detectSensitivePatterns()`(`src/pipeline.js`)가
  이메일/전화번호/`고객사:`·`사이트명:`·`담당자:` 레이블/주소형 문자열을 정규식으로 탐지. **체크박스를
  체크했더라도** 패턴이 감지되면 전송을 막음(체크박스=사람의 일반적 판단, 정규식=명백한 케이스에 대한
  기계적 이중 방어 — 서로 대체하지 않음). 자동 마스킹 없음, 감지된 패턴 종류·예시만 표시하고 원문은
  사용자가 직접 수정.

- [x] **Step 3: HTML/PPTX 로컬 텍스트 추출 구현** — `src/reference-docs.js`. HTML은 DOM parser 없이
  정규식으로 `<script>`/`<style>` 제거 후 태그 제거 + 엔티티 디코딩(브라우저·Node 테스트 환경 모두 동일
  동작 보장 목적). PPTX는 JSZip으로 `ppt/slides/slide*.xml`을 슬라이드 순서대로 읽어 `<a:t>` 텍스트만
  추출(슬라이드 레이아웃 등 다른 XML은 무시됨을 테스트로 확인). 원본 파일은 `state`에 저장하지 않고
  추출된 텍스트만 보관 — 서버 전송은 물론 세션 메모리에도 원본 Blob이 남지 않음.

- [x] **Step 4: 참고자료 출처와 truncation을 프롬프트에 명시** — `buildReferenceDocsBlock()`이 파일당
  20,000자 / 전체 60,000자 예산을 적용하고(초과 시 비침묵 truncation, Task 5와 동일 패턴), 각 발췌 앞에
  `[참고 파일: ...]`를 붙인다. `server/lib/prompts.js`의 `buildHypothesesPrompt()`에 "참고 보고서 수치를
  이번 이상 구간처럼 인용하지 말 것" 규칙을 명시적으로 추가.

- [x] **Step 5: privacy/reference 테스트 통과 확인**

Run: `npm test` → **43 unit + 11 e2e(desktop) 전부 PASS**(reference-docs 7건, privacy e2e 4건 신규 —
체크박스 미확인/PII 탐지 시 API 호출 0건 확인, 실제 HTML 파일 업로드→추출→`generate-hypotheses` 요청
바디에 `[참고 파일: reference-case-01.html]`로 정확히 반영되고 `<script>` 내용은 제외됨을 브라우저로
통합 검증).

### Task 7: 의존성 업데이트와 Node 실행 기준 고정

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`

**Interfaces:**
- Produces: Node `>=20.19.0`, Vite `8.2.2`, `@anthropic-ai/sdk` `0.120.0`, `@playwright/test` `1.62.1`, Zod `4.4.3` 기준의 재현 가능한 설치.

- [x] **Step 1: Task 1~6 테스트가 현재 lockfile에서 통과하는지 기준선 저장** — `npm test`(29 unit + 7 e2e) 전부 PASS를 베이스라인으로 기록. 추가로 서버 코드에는 아직 자동화되지 않은 위험(Anthropic SDK 실제 네트워크 호출 경로는 어떤 테스트도 exercise하지 않음)이 있다고 판단해, 업그레이드 전/후 비교용으로 **가짜 API 키로 실제 Anthropic 서버에 네트워크 요청을 보내 401 분류가 맞는지 확인하는 라이브 스모크 체크**를 임시 스크립트로 추가 수행(인증 실패는 과금 전 단계라 비용 0원). 업그레이드 전: `status:401` 정상 확인.

- [x] **Step 2: 의존성을 한 종류씩 업데이트하고 매번 테스트** — `@anthropic-ai/sdk@0.121.0`(계획 원안 0.120.0 대신 npm 레지스트리 확인 후 최신 0.121.0 사용) + `zod@4.4.3`(이미 설치돼 있어 재확인만), 이어서 `vite@8.2.2`(`@playwright/test@1.62.1`도 이미 설치됨). 각 단계마다 `npm test` PASS 확인. SDK 업그레이드 후 `AuthenticationError/RateLimitError/APIConnectionTimeoutError/APIError` 클래스가 동일 이름으로 존재하는지 확인 + 라이브 스모크 체크 재실행 → **여전히 `status:401` 정상**(에러 분류 경로가 새 SDK에서도 동일하게 동작). Vite 8 업그레이드 후 `npm run build` 정상(13 modules, 148KB), `npm run dev`(server+client 동시 기동) 및 `npm start`(프로덕션 단일 서버) 모두 curl로 라이브 확인 — `/api.js`는 vite가 직접 서빙(Task 1 수정이 vite 8에서도 유효), `/api/*`는 정상 프록시.

- [x] **Step 3: 취약점과 production dependency를 재검사**

Run: `npm audit && npm audit --omit=dev` → **둘 다 0 vulnerabilities**(업그레이드 전 moderate 1 + high 1이 있었던 esbuild/vite 취약점이 Vite 8 업그레이드로 완전히 해소됨 — 별도 수용 근거 기록 불필요). `package.json`에 `engines: {"node": "^20.19.0 || >=22.12.0"}`(Vite 8 요구사항과 동일) 추가, `README.md`에 명시.

### Task 8: 보고서 편집·모바일 레이아웃·완료 상태

**Files:**
- Modify: `src/state.js`
- Modify: `src/render.js`
- Modify: `src/styles.css`
- Create: `tests/e2e/report-edit.spec.js`
- Create: `tests/e2e/responsive.spec.js`

**Interfaces:**
- Produces: 수정 가능한 보고서/메일 초안, 명시적 `reviewed` 상태, 모바일에서 첫 화면에 본문 진입점 노출.

- [x] **Step 1: 보고서와 메일을 편집 가능한 textarea로 렌더링** — `state.reportEdits`/`state.emailEdits`를
  AI 원본(`state.report`/`state.email`)과 별도로 두는 구조(Task 2의 `confirmedHypothesis` 패턴과 동일).
  헤드라인·발생개요·이상구간요약·확정원인·조치권고, 메일 제목·본문 전부 `<textarea>`/`<input>`으로 전환,
  `oninput`은 render() 없이 state만 갱신(포커스 유지). 복사 버튼(`copyReportText`/`copyEmailText`)은
  숨겨진 텍스트영역이 아니라 **현재 편집된 `state.reportEdits`/`emailEdits` 값을 클릭 시점에 직접 읽어**
  복사 — 기존의 "숨겨진 textarea에 렌더링 시점 값 미리 굳혀두기" 방식(수정해도 복사 결과가 갱신 안 되던
  잠재적 버그)을 제거.

- [x] **Step 2: `최종 검토 완료` 체크 전 케이스 완료를 막기** — 문구 "본 보고서·메일의 **기술적 정확성**·
  **민감정보 미포함 여부**·**심각도 최종 판정**을 모두 검토·확정했습니다."(기존 human-note 문구와 동일
  세 항목을 재사용해 일관성 유지). `완료` 버튼은 Task 2와 같은 부분 DOM 갱신 패턴(`refreshCompleteButtonState`)
  으로 반응형 활성화. 완료 시점에 `state.reportEdits`/`emailEdits`/`finalReviewConfirmed`를 포함해 케이스
  히스토리 스냅샷을 한 번 더 갱신(기존엔 보고서 생성 직후 스냅샷 1회뿐이라 이후 편집 내용이 히스토리에
  반영 안 되는 문제가 있었음 — 계획에 없던 발견이라 별도로 수정).

- [x] **Step 3: 860px 이하에서 sidebar를 접이식 상단 영역으로 변경** — **원인이 계획과 달랐음**: 이미
  존재하던 모바일 미디어쿼리(`.sidebar{position:static;height:auto}`)가 CSS 파일에서 base `.sidebar{
  height:100vh}` 규칙보다 **앞**에 있어서, 동일 명시도에서 나중에 오는 base 규칙이 항상 이겼고 모바일
  오버라이드가 완전히 무효화되고 있었음(캐스케이드 순서 버그, 실제로 390px에서 사이드바 692px 폭 오버플로
  + 844px(=100vh) 높이로 렌더링되는 것을 Playwright로 실측 확인). 미디어쿼리를 파일 최하단으로 이동 +
  `.sidebar`/`.main`에 `min-width:0`(CSS Grid 콘텐츠 기반 자동 최소폭 오버플로 방지) 추가로 수정.

- [x] **Step 4: 데스크톱/모바일 Playwright 통과 확인**

Run: `npm test` → **43 unit + 24 e2e(4 skipped: responsive는 mobile 전용, report-edit은 desktop 전용
설계) 전부 PASS**. 수정 전/후 비교: 390px 가로 스크롤 있음(692px 오버플로) → 없음, 사이드바가 첫 화면
전체를 가림 → 로그 업로드 진입점 노출. 부수 효과로 이전에 "모바일 레이아웃 버그로 스킵" 처리했던
human-review/privacy e2e 스킵 가드도 제거 — 실제로 mobile-chromium에서도 전부 PASS함을 확인.

### Task 9: 실제 Claude 응답 파이프라인 라이브 검증 (방향 수정: CLI 기반, 유료 API 아님)

**2026-08-27 방향 수정**: "이 서비스는 테스트/시연용이라 유료 API 키를 쓰지 않는다"는 사용자 결정에
따라, Task 9의 전제(`ANTHROPIC_API_KEY` 발급 + 소액 과금 승인)를 없앴다. 대신 **백엔드가 로컬에
설치된 Claude Code CLI(`claude -p`)를 서브프로세스로 호출**하도록 새 provider를 추가했고
(`AI_PROVIDER=cli`가 기본값, 기존 API-key 경로는 `AI_PROVIDER=api`로 보존), 이 방식 그대로 실제
호출까지 전부 라이브로 검증했다 — 별도 API 키나 과금 없이 완료.

**Files (계획 대비 추가/변경):**
- Create: `server/lib/claude-cli.js` — `claude -p --output-format json --json-schema <tool.input_schema>`
  서브프로세스 호출, stdin으로 prompt 전달(Windows 명령줄 길이 제한 회피), `structured_output` 필드 추출.
- Create: `server/lib/ai-provider.js` — `AI_PROVIDER` 값으로 cli/api 두 구현 분기.
- Modify: `server/lib/anthropic.js`(변경 없음, `AI_PROVIDER=api` 경로로 보존), `server/routes/analysis.js`
  (provider dispatcher 사용 + 502 자동 재시도 1회), `server/lib/validation.js`(플레이스홀더 응답 거부 —
  아래 참고), `.env.example`/`.env`/`README.md`(AI_PROVIDER 문서화).
- Create: `server/lib/retry.js` + `tests/server/retry.test.js`.

- [x] **Step 1(수정): CLI 호출 플러밍 검증** — `claude -p --output-format json --json-schema '...'` 로
  실제 구조화 출력(`structured_output` 필드)이 스키마대로 검증됨을 확인. Windows 명령줄 길이 제한
  때문에 prompt는 인자가 아니라 **stdin**으로 전달(54KB 텍스트로 실측 확인, 실제 프롬프트는 최대
  300,000자까지 가능하므로 인자 전달은 애초에 불가능했음). `--allowedTools ""` + `--disable-slash-commands`
  + `cwd: os.tmpdir()`로 이 프로젝트의 CLAUDE.md/hooks/memory가 프롬프트에 섞여 들어가지 않도록 격리.
  `--bare`는 사용하지 않음(그 모드는 API 키 인증을 강제해 구독 기반 인증을 못 씀).

- [x] **Step 2: 4개 endpoint 실제 호출 — 전체 파이프라인 라이브 체이닝**

Express 서버를 띄운 뒤 detect-anomaly → generate-hypotheses → draft-report를 실제 순서대로 체이닝
호출(중간에 사람이 가설 선택·수정·심각도 확정하는 지점을 흉내내 `confirmedHyp`/`finalSeverity`를
수동으로 채워 다음 단계에 전달). 결과: 3단계 모두 실제 로그 수치(3.58V→3.95V, OV001, 시각 등)만
인용하고 없는 정보는 "추가 확인 필요"로 정확히 표기, headline→발생개요→기술적 의미→조치 순서 준수,
사람이 확정한 가설명/심각도가 보고서·메일에 정확히 반영됨. 총 소요 195초(3콜 합계) — CLI 방식은 매
호출마다 Claude Code 하네스를 새로 띄우므로 API 직접 호출보다 느림(참고용 실측, 아래 잔여 위험 참고).

**발견한 실제 버그(재현 후 즉시 수정)**: 첫 체이닝 실행에서 `generate-hypotheses` 응답이 스키마 형태는
맞지만 `name`/`expectedSignature`/`actualObservation`/`evidence`가 전부 문자열 `"test"`로 채워진
퇴화 응답을 반환함(109초 소요, 재실행 시엔 정상적인 고품질 응답으로 복귀 — 비결정적 현상). 이를 계기로
`validation.js`에 플레이스홀더 감지(`substantiveText()` — 알려진 placeholder 토큰 거부 + 가설 내
name/expectedSignature/actualObservation/evidence 4개 필드가 서로 동일하면 거부)를 추가하고,
`routes/analysis.js`에 502(응답 검증 실패 또는 CLI 문제) 한정 자동 재시도 1회를 추가함. 재수정 후
동일 시나리오 재실행 → 정상 응답, 재시도 없이 3단계 모두 성공. 회귀 테스트
(`tests/server/validation.test.js` 3건 추가, `tests/server/retry.test.js` 4건 신규) 전부 PASS.

- [ ] **Step 3: 공개 중첩 ZIP에서 하루치만 선택해 브라우저 검증** — 미완료. 브라우저 자동화 도구가
  이 세션에 없어 사람이 직접 `npm run dev`로 띄운 뒤 `PUBLIC_NEXT_DAY_FPPMW_20250817.zip`을 업로드해
  확인해야 함(카탈로그→"분석 포함"→AEMO 포맷/BESS 필터→전체 파이프라인). 로그 처리 자체(카탈로그,
  스트리밍 파싱, 엔티티 그룹핑, 프롬프트 예산)는 Node 스크립트로 이미 여러 차례 실측 검증됨(이전
  세션 기록 참고) — 남은 건 실제 UI 클릭 경로 확인뿐.

- [x] **Step 4: 개발/프로덕션 최종 smoke**

Run: `npm test`(36 unit + 7 e2e PASS) → `npm run build` → `node server/index.js`로 `/api/detect-issues`
실제 CLI 경로 호출까지 확인(200 OK, 실제 이슈 JSON 반환). `npm run dev`/`npm start`는 Task 7에서 이미
Vite 8 기준으로 확인됨.

- [x] **Step 5: PoC 성공 기준 기록** — `docs/verification/2026-08-27-live-smoke.md` 작성(API 키·실
  고객 데이터 없음, 환경 버전·PASS/FAIL·소요시간·잔여 위험만 기록).

**잔여 위험(다음 세션 참고)**:
1. CLI 방식은 호출당 지연이 크고(수십 초~2분), 드물게 비결정적으로 저품질/플레이스홀더 응답을 낼 수
   있음 — 재시도 1회로 완화했지만 완전히 제거되진 않음. 시연 목적으로는 충분하나, 운영 전환 시엔
   `AI_PROVIDER=api`로 전환하는 걸 권장.
2. `claude -p` 호출마다 Claude Code 하네스 전체를 로드해 `total_cost_usd`(구독 사용량 추정치) 수만~수십만
   토큰이 잡힘 — 실제 별도 과금은 아니지만 구독 사용량 한도를 소모하므로 고빈도 사용 시 유의.

---

## 2-1. 진행 상황 (2026-08-27 세션)

**Task 1~5, 7 완료** (P0 3개 + P1 2개 + 의존성 업그레이드). 모든 단계는 실패 재현 → 수정 → 자동 테스트
통과 순서로 진행했고, 실제 `PUBLIC_NEXT_DAY_FPPMW_20250817.zip` 데이터로도 재검증했다.
`node --test` 29개, Playwright e2e 7개(데스크톱) 모두 PASS. `npm run build`/`npm run dev`/`npm start`
모두 Vite 8.2.2 + `@anthropic-ai/sdk` 0.121.0 기준으로 라이브 확인 완료. `npm audit` 0건(기존
moderate 1 + high 1 취약점 해소).

**Task 9는 방향 수정 후 완료** — "유료 API 대신 Claude Code CLI로 시연"이라는 사용자 결정에 따라
`AI_PROVIDER=cli` provider를 새로 구현하고, 그 경로 그대로 4개 endpoint 전체를 실제 체이닝 호출까지
라이브 검증했다(과금 없음). 그 과정에서 실제 비결정적 버그(가설 응답이 전부 `"test"`로 채워지는
퇴화 응답)를 발견해 즉시 수정(플레이스홀더 검증 + 502 자동 재시도)하고 회귀 테스트까지 추가했다.
자세한 내용은 `docs/verification/2026-08-27-live-smoke.md`와 위 Task 9 섹션 참고. 브라우저 UI 클릭
경로만 미검증으로 남음(브라우저 자동화 도구 없음).

**Task 6, 8도 완료** — Task 6(민감정보 방어 체크박스+패턴 스캔, HTML/PPTX 참고자료 추출)과 Task 8
(보고서·메일 인라인 편집, 최종 검토 체크박스, 모바일 레이아웃)까지 이번 세션에서 전부 구현·검증했다.
**Task 8 Step 3 진행 중 계획에 없던 실제 CSS 버그**(모바일 미디어쿼리가 파일 순서상 무효화되고 있던
캐스케이드 버그)를 발견해 수정했고, 그 결과 이전엔 "모바일 레이아웃 문제로 임시 스킵" 처리했던
human-review/privacy e2e 테스트들도 스킵 가드를 걷어내고 mobile-chromium에서 전부 통과함을 확인했다.

**결과: plan.md의 Task 1~9 전부 완료.** 최종 `npm test` = unit 43개 + e2e 24개(4 skipped by design)
전부 PASS, `npm run build` 정상, `npm audit` 0건. 남은 것은 사람이 직접 브라우저에서 클릭해보는 최종
확인(§ "다음 세션 확인 사항" 참고)과, 원한다면 `AI_PROVIDER=api`로 전환해 실제 운영 배포를 준비하는
후속 작업뿐이다.

## 3. 실행 순서 (완료 기록)

1. ~~Task 1~3은 시연 전 필수 P0이다.~~ → **완료.**
2. ~~Task 4~5는 분석 신뢰도 필수 P1이다.~~ → **완료.**
3. ~~Task 6은 청사진의 과거 보고서 참조와 민감정보 원칙을 함께 다룬다.~~ → **완료.**
4. ~~Task 7은 테스트 기반이 생긴 뒤 수행한다.~~ → **완료** (`npm audit fix --force` 미사용, 명시 버전으로 업그레이드).
5. ~~Task 8은 기능 안정화 뒤 수행한다.~~ → **완료.**
6. ~~Task 9의 실제 API 호출은 사용자가 키 입력과 소액 API 비용 발생을 승인한 경우에만 수행한다.~~ →
   **방향 수정 후 완료**: 유료 API 대신 `AI_PROVIDER=cli`(Claude Code CLI)로 과금 없이 라이브 검증.

## 4. 현재 재개 명령

```powershell
cd C:\dev\ESSAnlyzer
npm install          # 이미 완료돼 있으면 생략 가능
cp .env.example .env  # 이미 있으면 생략 — 기본값 AI_PROVIDER=cli
npm run dev            # Vite(5173) + Express(3001)
```

`claude` CLI가 이 머신에 로그인돼 있으면 API 키 없이 바로 전체 파이프라인이 동작한다(`AI_PROVIDER=api`로
바꾸면 기존 `ANTHROPIC_API_KEY` 경로 사용). Task 1의 dev-mode 백지 화면 버그는 수정 완료 — 더 이상
재현되지 않는다.

## 4-1. 다음 세션 확인 사항 (미완료 항목)

- **브라우저 UI 클릭 경로 미검증**: 이 세션엔 브라우저 자동화 도구가 없어 Playwright(자동화 스크립트)로만
  검증했다. 사람이 실제로 `npm run dev` → 브라우저에서 파일 업로드~보고서까지 클릭해보는 확인은 아직 안 함.
- **`PUBLIC_NEXT_DAY_FPPMW_20250817.zip` 재검증**: 로그 처리 파이프라인 자체는 이전 세션에 Node
  스크립트로 실측 검증됐지만, 이번 세션의 변경(파서 교체, 프롬프트 예산, 엔티티 필터 등)을 반영한 재검증은
  아직 안 함 — 특히 대용량 카탈로그+스트리밍 흐름이 새 파서로도 동일 성능을 내는지 확인 권장.
- **`AI_PROVIDER=cli` 신뢰성**: 드물게 비결정적으로 저품질 응답이 나올 수 있음(재시도 1회로 완화됨).
  운영 전환 시 `AI_PROVIDER=api`로 바꾸고 실제 `ANTHROPIC_API_KEY`로 재검증 필요.

## 5. 원래 1차 구현에서 유지할 성과

- `src/`와 `server/` 분리, API 키 서버 보관 구조.
- 4개 분석 endpoint와 프롬프트 역할 분리.
- npm JSZip 사용, 중첩 ZIP 카탈로그 후 선택 처리.
- 4MB 청크 스트리밍, running 통계, bounded head/alarm sample.
- AEMO MMS adapter, BESS 자동 필터 제안, entity 그룹 상위 cap.
- 원본 로그 Blob을 서버에 업로드하지 않는 구조.
- 세션 히스토리 snapshot에서 File/JSZip 참조 제거.

이 성과는 유지하되, P0 사람 검토 게이트와 strict schema를 우선 복구한 뒤 확장한다.

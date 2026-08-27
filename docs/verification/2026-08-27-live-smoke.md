# 라이브 스모크 검증 기록 — 2026-08-27

API 키/실 고객 데이터는 기록하지 않음. `AI_PROVIDER=cli`(Claude Code CLI 서브프로세스 호출, 별도
과금 없음) 기준.

## 환경

- Node.js v24.19.0 (요구: `^20.19.0 || >=22.12.0`)
- Vite 8.2.2, `@anthropic-ai/sdk` 0.121.0, `@playwright/test` 1.62.1, `zod` 4.4.3, Express 4.21.1
- Claude Code CLI (로컬 설치, 구독 로그인 상태)
- 모델: `sonnet` alias (`claude-sonnet-5`)
- 샘플 데이터: 저장소 내 가상 OV001 과전압 시나리오(랙 #3). 실 고객 데이터 미사용.
- 공개 데이터: `PUBLIC_NEXT_DAY_FPPMW_20250817.zip`(AEMO 공개 시장 데이터) — 이전 세션에서 로그
  처리 파이프라인(카탈로그/스트리밍/그룹핑/프롬프트 예산) 검증에 사용, 이번 세션에서는 재사용 안 함.

## 결과

| 단계 | 상태 | 비고 |
|---|---|---|
| `npm run test:unit` (36건) | PASS | validation/retry 회귀 테스트 포함 |
| `npm run test:e2e` (Playwright, desktop) | PASS (7/7, mobile 5건은 Task 8 전까지 skip) | |
| `npm run build` | PASS | Vite 8.2.2, 148KB JS |
| `npm run dev` → `/api/detect-issues` 실호출 | PASS | HTTP 200, 실제 이슈 JSON 정상 반환 |
| `POST /api/detect-anomaly` 실호출 | PASS | 61.5s, 로그 수치만 인용, 추가 확인 필요 표기 정확 |
| `POST /api/generate-hypotheses` 실호출 (1차) | **FAIL → 수정 후 재검증 PASS** | 최초 호출에서 전 필드 `"test"` 퇴화 응답 발생(비결정적) → `validation.js` 플레이스홀더 감지 + 502 자동 재시도 추가 → 재검증 시 정상 응답(96.2s) |
| `POST /api/draft-report` 실호출 | PASS | 37.2s, 사람이 확정한 가설명·심각도가 보고서/메일에 정확히 반영됨 |
| 브라우저 UI(파일 업로드~보고서까지 클릭 경로) | **미검증** | 이 세션에 브라우저 자동화 도구 없음 — 사용자가 `npm run dev`로 직접 확인 필요 |

## 소요 시간(참고용, CLI 방식은 매 호출마다 Claude Code 하네스를 새로 띄워 API 직접 호출보다 느림)

- detect-anomaly: 61.5s
- generate-hypotheses: 96.2s (재검증 시, 1차 실패 시도는 109.1s)
- draft-report: 37.2s
- 3단계 합계: 약 195초

## 발견 및 수정한 실제 결함

**증상**: `generate-hypotheses` 1차 라이브 호출에서 JSON 스키마 형태는 맞으나 `name`,
`expectedSignature`, `actualObservation`, `evidence` 4개 필드가 전부 문자열 `"test"`인 퇴화 응답을
반환함. 동일 프롬프트로 재실행 시 고품질 응답 정상 반환 — 비결정적 현상으로 판단.

**대응**:
1. `server/lib/validation.js`: 알려진 플레이스홀더 토큰 거부 + 가설 내 4개 핵심 필드가 서로 동일한
   문자열이면 거부하는 `.refine()` 추가.
2. `server/routes/analysis.js`: 502(응답 검증 실패 또는 CLI 문제) 발생 시 자동 1회 재시도.
3. 회귀 테스트: `tests/server/validation.test.js`(퇴화 응답 거부 3건), `tests/server/retry.test.js`(재시도 로직 4건).

## 잔여 위험

1. CLI 방식은 드물게 비결정적으로 저품질 응답을 낼 수 있음 — 재시도 1회로 완화, 완전 제거는 아님.
2. 호출당 지연 크고(수십 초~2분), 호출마다 Claude Code 하네스 전체 로드로 구독 사용량을 상당히
   소모함(수만~수십만 토큰/콜) — 고빈도 운영에는 `AI_PROVIDER=api` 전환 권장.
3. 브라우저 UI 클릭 경로(파일 업로드부터 보고서까지)는 이번 세션에서 실측 못 함.

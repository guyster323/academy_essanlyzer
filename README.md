# ESS BMS 이슈 분석 워크스테이션

LG에너지솔루션 ESS 분석파트의 CS 의뢰 기반 BMS/EMS 이슈 분석 업무를 반자동화하는 워크스테이션.
사람이 핵심 판단(가설 선택·심각도 확정)을 하고, AI는 초안(이상 구간 탐지 → 원인 가설 → 보고서/메일)만
생성합니다 — 이 체크포인트는 어떤 기능을 추가하더라도 절대 생략하지 않습니다.

## 아키텍처

```
브라우저(src/)                         백엔드(server/)
├─ ZIP/중첩ZIP 카탈로그 + 스트리밍 파싱   ├─ /api/detect-issues
│  (파일은 로컬에서만 처리 — 업로드 없음)  ├─ /api/detect-anomaly
├─ 로그 포맷 자동 감지                    ├─ /api/generate-hypotheses
│  (일반 CSV / AEMO MMS 리포트)          └─ /api/draft-report
├─ 엔티티(BESS 등) 필터 + 그룹 집계          → AI_PROVIDER=cli(기본, 데모용) | api(운영용)
└─ 통계/샘플/알람 컨텍스트만 백엔드 전송
```

- **원본 로그 파일은 브라우저를 벗어나지 않습니다.** 4MB 청크로 스트리밍 파싱하며, 파일 크기가
  얼마든(500MB+, 심지어 zip 안에 zip이 들어있는 3GB+ 아카이브도) AI에게 보내는 프롬프트 크기는
  통계·헤드 샘플·알람 전후 컨텍스트로 고정됩니다.
- 백엔드는 프런트엔드가 보낸 집계 데이터로 프롬프트를 조립해 AI를 호출할 뿐, 원본 로그를 받지 않습니다.

### AI 호출 방식 (데모 vs 운영)

`.env`의 `AI_PROVIDER`로 전환합니다.

| 값 | 동작 | 필요한 것 | 구현 |
|---|---|---|---|
| `cli`(기본) | 로컬에 설치된 **Claude Code CLI**(`claude -p`)를 서브프로세스로 호출 | 이 머신에 `claude` 설치·로그인(구독 인증 재사용, 별도 API 키/과금 불필요) | `server/lib/claude-cli.js` |
| `api` | Anthropic Messages API를 SDK로 직접 호출(토큰 종량 과금) | `.env`의 `ANTHROPIC_API_KEY` | `server/lib/anthropic.js` |

두 경로 모두 동일한 `server/lib/schemas.js`의 JSON Schema를 구조화 출력 강제에 사용합니다
(`api`는 tool-use `strict:true`, `cli`는 `--json-schema` 플래그). 라우트(`server/lib/ai-provider.js`)는
`AI_PROVIDER` 값만 보고 두 구현 중 하나로 분기하므로 나머지 코드는 provider를 모릅니다.

`cli` 모드는 Claude Code 하네스를 매 호출마다 새로 띄우는 구조라 API 직접 호출보다 느리고(호출당
대략 수십 초 안팎, 프롬프트 크기에 따라 달라짐), 드물게 모델이 스키마 형태만 맞춘 부실한 응답을
반환하는 경우가 있어 `server/lib/validation.js`가 플레이스홀더성 응답(예: 모든 필드가 `"test"`)을
거부하고, `server/routes/analysis.js`가 그런 502 실패에 한해 자동으로 1회 재시도합니다.

## 로그 포맷 지원

| 포맷 | 인식 방법 | 비고 |
|---|---|---|
| 일반 CSV/TSV | 첫 줄이 헤더, 이후 데이터 행 | 전형적인 BMS/EMS export |
| AEMO MMS 리포트 | `C,`(주석)/`I,`(헤더)/`D,`(데이터) 레코드 타입 | 실제 컬럼은 4번째 필드부터 시작 |

AEMO 포맷은 `PARTICIPANTID`/`FPP_UNITID` 같은 엔티티 컬럼이 있으면 엔티티별로 그룹 집계하며,
`MW_QUALITY_FLAG != 1`을 알람 신호로 취급합니다. 값에 `BESS`가 포함된 엔티티가 감지되면 필터
입력칸에 자동으로 `BESS`를 채워 넣습니다(수정 가능).

## 대용량 ZIP(중첩 zip 포함) 처리

7일치 × 500MB급 CSV가 zip 안에 또 zip으로 들어있는 것과 같은 대형 아카이브를 열면:
1. 먼저 목록만 카탈로그합니다(파일명·크기·포맷만 확인, 압축 해제는 안 함).
2. 20MB 이하 항목은 바로 스트리밍 집계됩니다(소규모 zip 편의성 유지).
3. 그보다 큰 항목은 "카탈로그됨" 상태로 남고, "분석 포함(스트리밍 시작)" 버튼을 눌러야 실제로
   스트리밍 파싱이 시작됩니다 — 원치 않는 대량 CPU/시간 소모를 방지합니다.

## 시작하기

요구 사항: Node.js `^20.19.0` 또는 `>=22.12.0` (Vite 8 요구 버전).

```bash
npm install
cp .env.example .env   # 기본값 AI_PROVIDER=cli — claude CLI가 이미 로그인돼 있으면 바로 동작
npm run dev            # Vite dev server(5173) + Express API(3001, /api 프록시)
```

프로덕션 빌드:

```bash
npm run build
npm start               # NODE_ENV=production node server/index.js — 단일 포트로 API+정적 파일 서빙
```

## 지켜야 할 원칙

- **사람 검토 체크포인트 유지**: 가설 선택·심각도 확정 없이는 보고서 생성 버튼이 활성화되지 않습니다.
- **실 고객 데이터 커밋 금지**: `.gitignore`가 `*.zip`/`*.csv`/`*.tsv`/`.env`를 제외합니다. 개발·테스트는
  샘플/가상 데이터 또는 공개 데이터만 사용하세요.
- **localStorage 미사용**: 케이스 히스토리는 세션 메모리에만 유지되며 새로고침 시 초기화됩니다.

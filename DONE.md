# ESSAnlyzer 로그 파이프라인 일반화 작업 완료

`tmp/CODEX_TASK.md`와 전략 문서의 범위에 맞춰 기존 5단계 UI를 유지하면서 AEMO telemetry(Case A)와 LFP cell-array 필드 CSV(Case B)를 포맷 인식형 스트리밍 분석으로 확장했다. `Log_sample/`의 대용량 로그 파일은 이 워크트리에 추가하거나 커밋하지 않았다.

## 파일별 변경 사항

- `src/formats.js`: AEMO의 `FPP_UNITID` 우선 entity 선택을 적용하고, `MEASURED_MW` rolling mean/std·MAD robust z-score·ramp 기반 독립 파생 알람 훅을 추가했다. `Timestamp + U_Battery + U_Cell_1..8`를 인식하는 `lfp-cell-array` 어댑터를 추가해 파일 하나를 하나의 system으로 처리하고, leave-one-out cross-cell `Vdev`, robust z-score, 선택적 voltage closure, 데이터 기반 outlier Cell을 계산한다.
- `src/log-engine.js`: 포맷별 `computeDerivedAlarm` 훅을 호출하고, rolling state·파생 metric/reason/category 요약·알람 annotation을 bounded 구조로 보관한다. 그룹별 state를 분리해 entity 간 baseline 오염을 막고, JSZip async iterator의 조기 종료 cleanup을 보강했다.
- `src/pipeline.js`: 파생 요약/annotation과 `sourceProfiles`를 프롬프트에 전달하고 anomaly·hypothesis·report 전 단계 API payload에 유지한다. omission notice가 포함된 최종 `combinedLogText`도 `MAX_LOG_TEXT_CHARS=300000` 이내가 되도록 예산을 예약한다. `selectedHypId`·`finalSeverity` 기반 사람 검토 게이팅은 유지했다.
- `src/state.js`: 전략 문서의 계통/셀 분석 domain 목록과 단계 간 `sourceProfiles` 상태를 추가했다.
- `src/render.js`: 포맷/파생 알람 수, anomaly evidence tier, hypothesis의 반증 증거·누락 신호·주장 한계를 표시한다. ZIP 항목 오류를 일반 제외 파일과 구분해 표시하고 기존 사람 검토 체크포인트를 유지했다.
- `src/zip.js`: probe/stream 오류를 개별 source의 `error` 상태로 남기고, nested ZIP 및 entry별 오류를 형제 항목을 계속 처리할 수 있는 오류 수준 skip note로 표준화했다. JSZip의 `uncompressed data size mismatch`를 특별히 설명하는 helper를 추가했다.
- `server/lib/prompts.js`: AEMO의 독립 `MEASURED_MW` 탐지와 `MW_QUALITY_FLAG`/알려진 시각 비의존 규칙, LFP cross-cell 규칙, 포맷별 domain, `Observed/Derived/Inferred`, 반증·누락 신호·주장 한계를 프롬프트에 명시했다.
- `server/lib/schemas.js`: evidence tier 및 확장 domain enum을 추가하고 anomaly/hypothesis 출력과 strict tool schema에 필수 반증·누락 신호·claim-limit 필드를 추가했다.
- `server/lib/validation.js`: source profile 스키마와 300,000자 입력 상한을 추가하고, cell-array 응답이 전기화학적 열화·커넥터·부식을 확정하지 못하도록 문맥 검증을 추가했다. 원인 가설의 evidence tier는 `Inferred`로 제한했다.
- `server/routes/analysis.js`: 모델 응답 검증 시 요청의 source profile 문맥을 함께 전달한다.
- `tests/unit/formats.test.js`: LFP header 감지 및 AEMO `FPP_UNITID` 우선순위를 고정했다.
- `tests/unit/log-engine.test.js`: AEMO 품질 플래그가 정상이어도 `MEASURED_MW` 급변을 탐지하는지, LFP outlier Cell이 데이터에 따라 선택되는지, 정상 peer row가 오탐되지 않는지를 검증했다.
- `tests/unit/prompt-budget.test.js`: 파생 요약/source profile 전달과 프롬프트 상한을 검증했다.
- `tests/unit/zip.test.js`: JSZip mismatch 메시지와 source error 표시 helper를 검증했다.
- `tests/server/prompts.test.js`: AEMO/LFP 포맷별 prompt 지침과 Cell 8 사전 가정 금지·물리 원인 한계를 검증했다.
- `tests/server/validation.test.js`: 새 evidence 필드의 필수성, cell-array 물리 원인 주장 거부, bounded effective-series-resistance 주장 허용을 검증했다.
- `README.md`: 포맷 어댑터, 독립 파생 탐지, bounded prompt, evidence tier, LFP 주장 한계, JSZip 항목별 오류 처리를 문서화했다.
- `HANDOFF_TO_CLAUDE_CODE.md`: 후속 작업자가 사용할 AEMO/LFP 분석·prompt·ZIP 처리 계약과 한계를 갱신했다.
- `docs/superpowers/plans/2026-08-27-log-analysis-generalization.md`: 구현·검증 계획과 단계별 계약을 기록했다.
- `package-lock.json`: 작업 시작 전에 존재하던 Node `engines` 메타데이터 변경을 보존했다.
- `DONE.md`: 본 파일에 변경 사항, 한계, 검증 결과를 기록했다.

## 알려진 한계 및 후속 과제

- 전략 문서의 40단계 수동 포렌식 보고서 전체는 의도적으로 구현하지 않았다. 이번 범위는 기존 5단계 UI에서 두 케이스의 스트리밍 신호를 얻는 일반화이며, SOC/T/I 정합성, 저항·knee/GP/BattGP 분석, FTA 및 phase별 정식 보고서 산출은 별도 후속 과제다.
- AEMO 파생 탐지는 고정 rolling window와 휴리스틱 임계값을 사용한다. 이는 독립적인 이상 후보를 만드는 장치이지 사고 원인·정상/비정상 운전의 최종 판정이 아니며, 실제 운영 데이터로 임계값 보정이 필요하다.
- LFP 구현은 현재 8-cell 배열과 유한한 `U_Battery`가 있는 행을 대상으로 한다. closure는 pack 값이 있을 때만 계산하며, 전기화학적 저항을 직접 추정하지 않는다. voltage/resistance pattern이 지지하는 결론은 최대 “Cell N 경로의 유효 직렬저항 증가” 후보까지이고, 전기화학적 열화·커넥터·부식·정확한 root cause는 확정하지 않는다.
- 파생 state·요약·context는 고정 크기로 제한된다. 파일 전체 행, 전체 cell history, 전체 ZIP 내용을 AI로 보내지 않으며 생략이 생기면 prompt와 UI에 명시한다. 프런트와 백엔드의 `MAX_LOG_TEXT_CHARS`는 모두 `300000`이다.
- JSZip 오류 처리는 손상된 압축 데이터를 복구하는 방식이 아니다. entry를 오류 상태로 격리하고 형제 entry를 계속 처리하며, 손상된 nested ZIP은 오류 skip note로 남긴다. ZIP central directory/load 자체가 실패하거나 entry가 실제로 손상된 경우 해당 내용을 되살릴 수 없고, live archive fixture 검증은 샘플 파일이 이 워크트리에 없어 수행하지 않았다.
- AI provider 연결부는 변경하지 않았다. 실제 Claude/Anthropic 호출과 실제 공개 archive의 end-to-end 분석은 별도 환경 검증이 필요하다.

## 검증 결과

- `npm run test:unit` — 56 passed, 0 failed
- `npm run test:e2e` — 24 passed, 4 skipped
- `npm run build` — passed
- `git diff --check` — passed
- `Log_sample/*.zip` — `.gitignore`의 `*.zip` 규칙으로 ignore 확인; 샘플 데이터는 추가/커밋하지 않음

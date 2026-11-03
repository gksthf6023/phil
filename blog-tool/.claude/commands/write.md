---
description: 사진+메모로 네이버 블로그 초안 작성 → 승인 후 임시저장
argument-hint: [소재/메모 — 예: 용산 고봉당 매운등갈비, 일행과 방문]
---

CLAUDE.md의 절대 규칙·글쓰기 공식·자가 검증 원칙을 전부 따른다. 입력: $ARGUMENTS

## 1. 입력 수집
- `input/photos/`(`_mosaic/` 제외), `input/videos/`, `data/profile.md`, `data/blogger-profile.md`, `data/authority-lines.md`, `data/sponsored-disclosure.md`, `data/style-profile.md`, `data/trends.md`를 읽는다.
- 사진은 **Read로 한 장씩 직접 본다.** 파일명 순서가 아니라 보이는 내용 기준으로 스토리 순서를 정한다.

## 2. 필수 확인 (빠진 것만 한 번에 묻기 — 임의 판단 금지)
- **협찬·체험단 여부** (메모에 없으면 반드시 질문. 규칙 3-1)
- 메인 키워드·방문 일시·인원
- 맛집 체크리스트 중 profile.md/사진에서 확인 안 되는 항목: 교통·주차·웨이팅·좌석·메뉴별 가격·맛 메모·단점
- 확인 안 된 항목은 묻거나 뺀다. **지어내지 않는다.**

## 3. 개인정보 점검
- 타인 얼굴·번호판·전화번호·화자 얼굴 식별 시 mosaic spec 작성 → `node scripts/mosaic.js <spec>` → 처리본을 Read로 열어 가려졌는지 확인 → 초안엔 처리본 경로.

## 4. 설계 보고 후 초안 작성
- 페르소나 1명(지역·나이·직책·상황·감정), 후킹 패턴(직전 글과 다르게), 키워드 배치 계획을 먼저 짧게 보고.
- `drafts/YYYYMMDD-slug.json` 작성 (포맷은 CLAUDE.md). tags 5~10개, place 필수, 영상 있으면 video.
- 협찬이면 첫 블록 = 표기 문구 text 블록.

## 5. 자체 검수 후 사용자에게 보고
- 글자 수, 사진 수, 키워드 횟수(메인 5~7회, 띄어쓰기 동일형 1회 이상), 제목 글자 수(25~32)
- 맛집 체크리스트 항목별 대조표 (✔/❗)
- 페르소나, 모자이크 처리 내역, 단점 포함 여부
- 자가 질문: "모바일에서 인용구와 소제목만 훑어도 핵심이 전달되는가?"
- 본문 미리보기를 보여주고 **"임시저장 진행할까요?"로 승인을 받는다. 승인 전 저장 금지(규칙 6).**

## 6. 승인 후 임시저장
1. `node scripts/naver_draft.js drafts/<file>.json --dry-run` 로 먼저 점검 (셀렉터 수정 중엔 필수)
2. 문제 없으면 `node scripts/naver_draft.js drafts/<file>.json`
3. 실패 시 추측 수정 금지 → `node scripts/probe_selectors.js` 실측 후 수정. 3회 실패하면 수동 붙여넣기 원고 출력.

## 7. 이중 검증 (필수)
- 스크린샷 + `drafts/<file>.dump.txt`(제목·본문 전체 텍스트)를 초안과 전문 대조. 불일치 시 성공 보고 금지.
- 로그의 "자동 처리 결과" 블록에서 ❗수동 필요 항목만 안내.

## 8. 마무리 안내
CLAUDE.md "발행 체크리스트" 수동 항목 + 디버깅 실패본 "저장 글" 직접 정리 안내. 새 교훈은 CLAUDE.md 교훈 로그에 기록하고 안정 스크립트는 `.working.js`로 백업.

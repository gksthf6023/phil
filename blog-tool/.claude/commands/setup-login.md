---
description: 네이버 로그인 세션 최초 1회 생성 (사용자가 브라우저에서 직접 로그인)
---

1. `npm install` 및 `npx playwright install chromium`이 안 되어 있으면 안내/실행.
2. `node scripts/naver_login.js` 실행. 브라우저 창이 뜨면 **사용자가 직접** 로그인(2단계 인증 포함)하도록 안내. 아이디·비밀번호를 대화로 받거나 저장하지 않는다.
3. 로그인 완료가 감지되면 스크립트가 세션을 `naver-profile/`에 저장하고 종료한다.
4. `naver-profile/`은 로그인 세션이므로 외부 공유·커밋 금지(.gitignore 처리됨)임을 안내.
5. 이후 `/write`가 이 세션을 재사용한다. 세션이 만료되면 이 명령을 다시 실행.

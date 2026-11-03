#!/usr/bin/env node
// 네이버 로그인 세션 최초 1회 생성.
// - 로그인은 사용자가 열린 브라우저에서 직접 한다. 아이디/비밀번호는 코드·파일 어디에도 저장하지 않는다.
// - 세션은 naver-profile/ (persistentContext)에 쿠키로 남는다. 외부 공유 금지.
const path = require('path');
const { chromium } = require('playwright');

const PROFILE_DIR = path.join(__dirname, '..', 'naver-profile');
const TIMEOUT_MS = 10 * 60 * 1000;

(async () => {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1600, height: 1000 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = context.pages()[0] || (await context.newPage());
  await page.goto('https://nid.naver.com/nidlogin.login', { waitUntil: 'domcontentloaded' });

  console.log('▶ 열린 브라우저 창에서 네이버에 직접 로그인하세요 (2단계 인증 포함).');
  console.log('  비밀번호는 이 도구가 읽거나 저장하지 않습니다. 최대 10분 대기.');
  console.log('  팁: "로그인 상태 유지"를 체크해 두면 세션이 오래 갑니다.');

  const start = Date.now();
  let ok = false;
  while (Date.now() - start < TIMEOUT_MS) {
    const cookies = await context.cookies('https://www.naver.com');
    const loggedIn = cookies.some((c) => c.name === 'NID_AUT') && cookies.some((c) => c.name === 'NID_SES');
    if (loggedIn && !page.url().includes('nidlogin')) { ok = true; break; }
    await page.waitForTimeout(1500);
  }

  if (!ok) {
    console.error('❗ 시간 초과: 로그인이 확인되지 않았습니다. /setup-login 을 다시 실행하세요.');
    await context.close();
    process.exit(1);
  }

  // 블로그 글쓰기 페이지 접근 가능 여부까지 확인
  await page.goto('https://blog.naver.com/GoBlogWrite.naver', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(3000);
  const blogOk = !page.url().includes('nidlogin');
  console.log(blogOk ? '✔ 로그인 세션 저장 완료 (naver-profile/). 이제 /write 를 쓸 수 있습니다.'
                     : '❗ 로그인은 됐지만 블로그 글쓰기 접근이 로그인 페이지로 리다이렉트됩니다. 블로그 개설 여부를 확인하세요.');
  await context.close();
  process.exit(blogOk ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

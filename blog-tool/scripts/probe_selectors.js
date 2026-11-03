#!/usr/bin/env node
// 셀렉터 진단용 DOM 덤프 — 읽기 전용. 글을 쓰거나 저장하거나 어떤 버튼도 누르지 않는다.
// 사용: node scripts/probe_selectors.js   → drafts/probe-<timestamp>.json 출력
// 셀렉터가 깨졌을 때 추측하지 말고 이걸로 실제 클래스를 확인한 뒤 naver_draft.js를 고친다.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PROFILE_DIR = path.join(ROOT, 'naver-profile');

// 발행 차단 가드 (읽기 전용이지만 같은 안전장치를 건다)
const GUARD_SRC = `(() => {
  if (window.__naverPublishGuard) return; window.__naverPublishGuard = true;
  const SEL = 'button[data-testid="seOnePublishBtn"]';
  const block = (e) => { const t = e.target && e.target.closest ? e.target.closest(SEL) : null;
    if (t) { e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation(); } };
  ['click','mousedown','mouseup','pointerdown','pointerup','auxclick','dblclick'].forEach(n => window.addEventListener(n, block, true));
})();`;

(async () => {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false, viewport: { width: 1600, height: 1000 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  await context.addInitScript(GUARD_SRC);
  const page = context.pages()[0] || (await context.newPage());
  await page.goto('https://blog.naver.com/GoBlogWrite.naver', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);

  if (page.url().includes('nidlogin')) { console.error('❗ 로그인 세션 없음 → /setup-login'); await context.close(); process.exit(1); }

  const handle = await page.$('iframe#mainFrame');
  const frame = handle ? await handle.contentFrame() : page;
  await frame.waitForSelector('.se-title-text, .se-component', { timeout: 20000 }).catch(() => {});

  const dump = await frame.evaluate(() => {
    const info = (el) => ({
      tag: el.tagName.toLowerCase(),
      cls: el.className && el.className.toString().slice(0, 200),
      testid: el.getAttribute('data-testid'),
      name: el.getAttribute('data-name'),
      aria: el.getAttribute('aria-label'),
      title: el.getAttribute('title'),
      text: (el.innerText || '').trim().slice(0, 40),
      visible: !!(el.offsetWidth || el.offsetHeight),
    });
    const q = (s) => Array.from(document.querySelectorAll(s)).map(info);
    return {
      url: location.href,
      viewport: { w: innerWidth, h: innerHeight },
      toolbarButtons: q('button[class*="toolbar-button"], .se-toolbar button'),
      allButtonsWithTestId: q('button[data-testid]'),
      topBarButtons: q('[class*="publish"] button, button[class*="publish"], button[class*="save"]'),
      popups: q('[class*="se-popup"]'),
      helpPanel: q('[class*="help-panel"]'),
      title: q('.se-title-text, .se-section-documentTitle'),
      bodyParagraphs: q('.se-section-text p.se-text-paragraph'),
      components: q('.se-component'),
      inputs: q('input, textarea'),
    };
  });

  const out = path.join(ROOT, 'drafts', `probe-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(dump, null, 2));
  console.log(`✔ DOM 덤프: ${path.relative(ROOT, out)}`);
  console.log(`  툴바 버튼 ${dump.toolbarButtons.length}개 / 팝업 ${dump.popups.length}개 / 입력창 ${dump.inputs.length}개`);
  console.log('  (팝업·패널 안 요소가 필요하면 브라우저에서 직접 열어 둔 채로 다시 실행하세요 — 이 스크립트는 아무것도 클릭하지 않습니다.)');
  await page.waitForTimeout(1500);
  await context.close();
})().catch((e) => { console.error(e); process.exit(1); });

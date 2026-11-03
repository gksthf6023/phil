#!/usr/bin/env node
// 네이버 블로그 임시저장 자동화. 발행은 하지 않는다 (installPublishGuard 참고 — 제거 금지).
//
// 사용:
//   node scripts/naver_draft.js drafts/xxx.json              # 임시저장까지
//   node scripts/naver_draft.js drafts/xxx.json --dry-run    # 저장 클릭만 생략 (셀렉터 디버깅용, 항상 먼저)
//   node scripts/naver_draft.js drafts/xxx.json --validate   # 브라우저 없이 초안 JSON만 검사
//   --keep-open  : 끝나고 브라우저를 열어 둠 (Ctrl+C로 종료)
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PROFILE_DIR = path.join(ROOT, 'naver-profile');
const WRITE_URL = 'https://blog.naver.com/GoBlogWrite.naver';
const PUBLISH_SEL = 'button[data-testid="seOnePublishBtn"]'; // 진짜 발행 버튼 — 절대 클릭 금지
const BODY_P = '.se-section-text p.se-text-paragraph';        // 본문 셀렉터 (제목 오염 방지로 반드시 이 범위)
const EMOJI_RE = /(\p{Extended_Pictographic}[️‍\p{Extended_Pictographic}]*)/u;

const args = process.argv.slice(2);
const DRAFT_PATH = args.find((a) => !a.startsWith('--'));
const DRY_RUN = args.includes('--dry-run');
const VALIDATE_ONLY = args.includes('--validate');
const KEEP_OPEN = args.includes('--keep-open');

// ───────────────────────── 발행 차단 가드 (절대 규칙 2 — 어떤 경우에도 제거 금지) ─────────────────────────
// 에디터 로드 직후 + 이후 생성되는 모든 문서/프레임에 "캡처 단계" 리스너를 걸어
// button[data-testid="seOnePublishBtn"] 로 가는 클릭/키 입력을 원천 차단한다.
const GUARD_SRC = `(() => {
  if (window.__naverPublishGuard) return;
  window.__naverPublishGuard = true;
  window.__publishBlocked = 0;
  const SEL = ${JSON.stringify(PUBLISH_SEL)};
  const block = (e) => {
    const t = e.target && e.target.closest ? e.target.closest(SEL) : null;
    if (t) { e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation(); window.__publishBlocked++; }
  };
  ['click','mousedown','mouseup','pointerdown','pointerup','auxclick','dblclick'].forEach((n) => window.addEventListener(n, block, true));
  const key = (e) => {
    const a = document.activeElement;
    if ((e.key === 'Enter' || e.key === ' ') && a && a.matches && a.matches(SEL)) {
      e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation(); window.__publishBlocked++;
    }
  };
  ['keydown','keyup','keypress'].forEach((n) => window.addEventListener(n, key, true));
})();`;

async function installPublishGuard(context, page) {
  await context.addInitScript(GUARD_SRC); // 이후 로드되는 모든 프레임
  for (const f of page.frames()) {        // 이미 로드된 프레임
    await f.evaluate(GUARD_SRC).catch(() => {});
  }
}

async function assertGuard(page, label) {
  for (const f of page.frames()) {
    if (f.url() === 'about:blank') continue;
    const ok = await f.evaluate(() => window.__naverPublishGuard === true).catch(() => false);
    if (!ok) {
      await f.evaluate(GUARD_SRC).catch(() => {});
      const again = await f.evaluate(() => window.__naverPublishGuard === true).catch(() => false);
      if (!again) throw new Error(`발행 차단 가드 설치 실패 (${label}, frame ${f.url()}) — 안전을 위해 중단`);
    }
  }
}

// 모든 클릭은 이 래퍼를 통과 — 발행 버튼이면 코드 레벨에서도 거부
async function safeClick(loc, opts = {}) {
  const isPublish = await loc.first().evaluate((el, sel) => !!el.closest(sel), PUBLISH_SEL).catch(() => false);
  if (isPublish) throw new Error('발행 버튼 클릭 시도 차단 (절대 규칙 2)');
  await loc.first().click({ timeout: 8000, ...opts });
}

// ───────────────────────── 초안 검증 ─────────────────────────
function loadDraft() {
  if (!DRAFT_PATH) { console.error('사용: node scripts/naver_draft.js drafts/<file>.json [--dry-run|--validate|--keep-open]'); process.exit(1); }
  const abs = path.resolve(DRAFT_PATH);
  const d = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const errs = [], warns = [];
  const len = (s) => [...(s || '')].length;

  if (!d.title) errs.push('title 없음');
  else if (len(d.title) < 25 || len(d.title) > 32) warns.push(`제목 ${len(d.title)}자 (권장 25~32)`);
  if (/[!?★☆♥♡◆◇■□▶▷※]/.test(d.title || '')) warns.push('제목에 특수문자 포함 (저품질 회피: 제거 권장)');
  if (!Array.isArray(d.blocks) || !d.blocks.length) errs.push('blocks 없음');
  if (!Array.isArray(d.tags) || d.tags.length < 5 || d.tags.length > 10) warns.push(`tags ${d.tags ? d.tags.length : 0}개 (권장 5~10)`);
  if (!d.place || !d.place.query) warns.push('place 없음 — 지역 업종 글에서는 필수');
  if (d.video) {
    if (!d.video.path || !fs.existsSync(path.resolve(ROOT, d.video.path))) errs.push(`영상 파일 없음: ${d.video && d.video.path}`);
    if (!d.video.title) errs.push('video.title 필수');
    else if (len(d.video.title) > 40) errs.push(`video.title ${len(d.video.title)}자 (40자 제한)`);
  }

  let textChars = 0, images = 0, quotes = 0;
  const seenImg = new Set();
  (d.blocks || []).forEach((b, i) => {
    if (!['text', 'subtitle', 'image', 'quote', 'divider'].includes(b.type)) errs.push(`blocks[${i}] 알 수 없는 type: ${b.type}`);
    if (['text', 'subtitle', 'quote'].includes(b.type)) { textChars += len(b.text); if (!b.text) errs.push(`blocks[${i}] text 비어 있음`); }
    if (b.type === 'quote') quotes++;
    if (b.type === 'image') {
      images++;
      const p = path.resolve(ROOT, b.path || '');
      if (!b.path || !fs.existsSync(p)) errs.push(`blocks[${i}] 사진 없음: ${b.path}`);
      if (seenImg.has(p)) errs.push(`blocks[${i}] 사진 재사용 금지: ${b.path}`);
      seenImg.add(p);
    }
  });
  if (!(d.blocks || []).some((b) => b.type === 'text')) errs.push('text 블록이 하나도 없음');
  if (textChars < 1200) warns.push(`본문 ${textChars}자 (권장 1,800~2,500)`);
  if (textChars > 3200) warns.push(`본문 ${textChars}자 (정보성 3,000자까지)`);
  if (quotes < 2 || quotes > 4) warns.push(`인용구 ${quotes}개 (권장 2~4)`);

  // 협찬 안전장치 (규칙 3-1): sponsored:true 이면 표기 필수 + 거짓 부인 표현 금지
  const allText = (d.blocks || []).map((b) => b.text || '').join('\n');
  if (d.sponsored) {
    const first = (d.blocks && d.blocks[0]) || {};
    if (first.type !== 'text' || !/제공받|지급받|수수료|할인/.test(first.text || '')) errs.push('협찬 글인데 첫 블록이 협찬 표기 text 블록이 아님');
    if (/내돈내산|광고\s*아님|협찬\s*(없|아님)/.test(allText + (d.title || ''))) errs.push('협찬 글에 거짓 부인 표현(내돈내산/광고 아님) 포함 — 위법');
  }

  console.log(`초안 검증: 제목 ${len(d.title)}자 / 본문 ${textChars}자 / 사진 ${images}장 / 인용구 ${quotes}개 / 태그 ${(d.tags || []).length}개`);
  warns.forEach((w) => console.log('  ⚠ ' + w));
  errs.forEach((e) => console.log('  ❗ ' + e));
  if (errs.length) { console.error('초안 오류로 중단'); process.exit(1); }
  return { d, abs };
}

// ───────────────────────── 메인 ─────────────────────────
const results = {}; // 자동 처리 결과 블록
const rec = (k, ok, note = '') => { results[k] = { ok, note }; };

(async () => {
  const { d, abs } = loadDraft();
  if (VALIDATE_ONLY) { console.log('✔ --validate 완료 (브라우저 미실행)'); return; }
  const base = abs.replace(/\.json$/, '');

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1600, height: 1000 }, // 1400 이하면 패널 열 때 속성 툴바가 잘려 서식 클릭이 불안정
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = context.pages()[0] || (await context.newPage());
  page.on('dialog', (dlg) => dlg.dismiss().catch(() => {}));

  try {
    await page.goto(WRITE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    if (page.url().includes('nidlogin')) throw new Error('로그인 세션 없음/만료 → /setup-login 실행');

    // 에디터는 iframe#mainFrame 안 (없으면 페이지 자체가 에디터)
    const handle = await page.waitForSelector('iframe#mainFrame', { timeout: 8000 }).catch(() => null);
    const F = handle ? await handle.contentFrame() : page;
    await F.waitForSelector('.se-title-text', { timeout: 30000 });

    await installPublishGuard(context, page); // 에디터 로드 직후 — 이후 어떤 조작보다 먼저
    await assertGuard(page, '에디터 로드 직후');
    console.log('✔ 발행 차단 가드 설치·확인');

    // 팝업 정리: 작성 중인 글 → 새로 쓰기, 도움말 닫기
    const cancel = F.locator('.se-popup-button-cancel');
    if (await cancel.first().isVisible().catch(() => false)) { await safeClick(cancel); await page.waitForTimeout(800); }
    const help = F.locator('.se-help-panel-close-button');
    if (await help.first().isVisible().catch(() => false)) { await safeClick(help); await page.waitForTimeout(500); }

    // ───── 헬퍼 ─────
    const paras = () => F.locator(BODY_P);
    const focusEnd = async () => {
      const n = await paras().count();
      await safeClick(paras().nth(n - 1));
      await page.keyboard.press('ControlOrMeta+End');
    };
    // 마지막 컴포넌트가 텍스트가 아니면(이미지/구분선/지도 등) 아래에 빈 문단을 만든다
    const ensureTrailingParagraph = async () => {
      const lastIsText = await F.evaluate(() => {
        const comps = document.querySelectorAll('.se-main-container .se-component');
        const last = comps[comps.length - 1];
        return !last || last.classList.contains('se-text');
      });
      if (!lastIsText) {
        const comps = F.locator('.se-main-container .se-component');
        await safeClick(comps.nth((await comps.count()) - 1));
        await page.keyboard.press('Enter');
        await page.waitForTimeout(300);
      }
    };
    const currentParaEmpty = () => F.evaluate(() => {
      const s = document.getSelection();
      const el = s && s.anchorNode && (s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement);
      const p = el && el.closest('p.se-text-paragraph');
      return p ? (p.innerText || '').replace(/​/g, '').trim() === '' : true;
    });
    const ensureEmptyParagraph = async () => { if (!(await currentParaEmpty())) { await page.keyboard.press('Enter'); await page.waitForTimeout(150); } };
    const insertSegments = async (line) => {
      for (const seg of line.split(EMOJI_RE)) {
        if (!seg) continue;
        await page.keyboard.insertText(seg); // 한글은 반드시 insertText (type은 IME 꼬임)
        if (EMOJI_RE.test(seg)) await page.waitForTimeout(80); // 이모지는 별도 호출
      }
    };
    const typeLines = async (text) => {
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        await insertSegments(lines[i]);
        if (i < lines.length - 1) await page.keyboard.press('Enter');
      }
    };
    const toolbarBtn = (cls) => F.locator(`button.${cls}`).first();
    const pickOption = async (re) => {
      const opt = F.locator('li, button, span, a').filter({ hasText: re }).filter({ visible: true }).last();
      await safeClick(opt);
    };
    const formatLabel = () => F.locator('button.se-text-format-toolbar-button').first().innerText().then((t) => t.trim()).catch(() => '');

    // 팝업 확실히 닫기 (Escape는 안 먹는다 — 닫기 버튼, 실패 시 DOM 강제 제거. dim 잔류하면 이후 클릭 전부 실패)
    const closePopup = async (popupSel, closeSel) => {
      const close = F.locator(`${popupSel} ${closeSel}`).first();
      if (await close.isVisible().catch(() => false)) await close.click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(500);
      const still = await F.locator(popupSel).first().isVisible().catch(() => false);
      if (still) {
        await F.evaluate((sel) => {
          document.querySelectorAll(sel).forEach((e) => e.remove());
          document.querySelectorAll('[class*="se-popup-dim"], [class*="popup-dim"]').forEach((e) => e.remove());
        }, popupSel);
        return 'forced';
      }
      await F.evaluate(() => document.querySelectorAll('[class*="se-popup-dim"]').forEach((e) => e.remove())).catch(() => {});
      return 'closed';
    };

    // ───── 본문 입력 (본문 전체 먼저 → 제목은 맨 마지막) ─────
    await safeClick(paras().first());
    const blocks = d.blocks;
    let firstTextDone = false, subtitleOK = 0, subtitleTotal = 0, imgOK = 0, capOK = 0, capTotal = 0;
    const firstText = (blocks.find((b) => b.type === 'text') || {}).text || '';

    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const next = blocks[i + 1];
      process.stdout.write(`  [${i + 1}/${blocks.length}] ${b.type}\r`);

      if (b.type === 'text') {
        await ensureEmptyParagraph().catch(() => {});
        await typeLines(b.text);
        if (next && next.type === 'text') await page.keyboard.press('Enter'); // 연속 text는 빈 줄을 하나 더
        if (!firstTextDone) {
          firstTextDone = true;
          if (d.video) await insertVideo(d.video); // 항상 첫 text 블록 직후
        }
      } else if (b.type === 'subtitle') {
        subtitleTotal++;
        await ensureEmptyParagraph();
        // 순서가 핵심: 서식 → 크기 → 텍스트 (입력 후 바꾸면 이미 쓴 글자에 적용 안 됨). 볼드 토글 금지.
        let applied = false;
        try {
          await safeClick(toolbarBtn('se-text-format-toolbar-button'));
          await pickOption(/^\s*소제목\s*$/);
          await page.waitForTimeout(250);
          await safeClick(toolbarBtn('se-font-size-code-toolbar-button'));
          await safeClick(F.locator('[class*="fs19"]').filter({ visible: true }));
          await page.waitForTimeout(250);
          applied = (await formatLabel()).includes('소제목');
        } catch (e) { applied = false; }
        await insertSegments(b.text);
        await page.keyboard.press('Enter');
        // 다음 문단은 "본문"으로 명시 복귀 + 크기 복귀
        try {
          await safeClick(toolbarBtn('se-text-format-toolbar-button'));
          await pickOption(/^\s*본문\s*$/);
          await safeClick(toolbarBtn('se-font-size-code-toolbar-button'));
          await safeClick(F.locator('[class*="fs15"]').filter({ visible: true }));
        } catch (e) { /* 크기 복귀 실패는 덤프 검증에서 드러남 */ }
        if (applied) subtitleOK++;
      } else if (b.type === 'quote') {
        await ensureEmptyParagraph();
        await safeClick(toolbarBtn('se-insert-quotation-default-toolbar-button'));
        await page.waitForTimeout(400);
        await typeLines(b.text);
        await page.keyboard.press('ArrowDown'); // 인용구 밖으로
        await ensureTrailingParagraph();
        await focusEnd();
      } else if (b.type === 'divider') {
        await ensureEmptyParagraph();
        await safeClick(toolbarBtn('se-insert-horizontal-line-default-toolbar-button'));
        await page.waitForTimeout(400);
        await ensureTrailingParagraph();
        await focusEnd();
      } else if (b.type === 'image') {
        await ensureEmptyParagraph();
        const before = await F.locator('.se-component.se-image').count();
        const [chooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 10000 }),
          safeClick(F.locator('button.se-image-toolbar-button')),
        ]);
        await chooser.setFiles(path.resolve(ROOT, b.path));
        let up = false;
        for (let t = 0; t < 60; t++) { // 최대 ~60초
          if ((await F.locator('.se-component.se-image').count()) > before) { up = true; break; }
          await page.waitForTimeout(1000);
        }
        if (up) imgOK++;
        await page.waitForTimeout(1200);
        // 일부 환경에서 사진 위치 선택 팝업/도움말이 뜰 수 있다
        const helpAgain = F.locator('.se-help-panel-close-button');
        if (await helpAgain.first().isVisible().catch(() => false)) await helpAgain.first().click().catch(() => {});
        if (b.caption) {
          capTotal++;
          try { // 캡션 셀렉터는 미검증 추정(.se-caption) — 실패하면 수동 안내. probe로 실측 필요.
            const cap = F.locator('.se-component.se-image').nth(before).locator('.se-caption p.se-text-paragraph, .se-caption .se-text-paragraph').first();
            await safeClick(cap);
            await page.keyboard.insertText(b.caption);
            capOK++;
          } catch (e) { /* 아래 결과에 ❗ */ }
        }
        await ensureTrailingParagraph();
        await focusEnd();
      }
    }
    process.stdout.write('\n');
    rec('소제목', subtitleTotal === 0 ? 'skip' : subtitleOK === subtitleTotal, `${subtitleOK}/${subtitleTotal}`);
    rec('사진', imgOK === blocks.filter((b) => b.type === 'image').length, `${imgOK}/${blocks.filter((b) => b.type === 'image').length}`);
    if (capTotal) rec('캡션', capOK === capTotal, `${capOK}/${capTotal} (캡션 셀렉터 미검증)`);
    if (!d.video) rec('동영상', 'skip', '초안에 video 없음');

    // ───── 지도 (글 맨 끝) ─────
    if (d.place && d.place.query) await insertPlace(d.place);
    else rec('지도', 'skip', 'place 없음');

    // ───── 본문 첫 줄 누락 보정 (저장 전) ─────
    const head = firstText.replace(/\s+/g, '').slice(0, 10);
    const firstBody = (await paras().first().innerText().catch(() => '')).replace(/\s+/g, '');
    if (head && !firstBody.includes(head)) {
      console.log('  ⚠ 본문 첫 줄 누락 감지 → 맨 앞에 보정 삽입');
      await safeClick(paras().first());
      await page.keyboard.press('ControlOrMeta+Home');
      await insertSegments(firstText.split('\n')[0]);
      await page.keyboard.press('Enter');
    }

    // ───── 제목 (맨 마지막) ─────
    const titleEl = F.locator('.se-title-text').first();
    let titleOK = false;
    for (let t = 0; t < 3 && !titleOK; t++) {
      await safeClick(titleEl);
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.press('Backspace');
      await page.keyboard.insertText(d.title);
      await page.waitForTimeout(400);
      const got = (await titleEl.innerText()).replace(/\s+/g, '');
      titleOK = got === d.title.replace(/\s+/g, '');
      if (!titleOK) console.log(`  ⚠ 제목 불일치(시도 ${t + 1}): "${got}"`);
    }
    rec('제목', titleOK, titleOK ? '입력값 일치' : '3회 재시도 후에도 불일치');

    // ───── 태그 (발행 패널 열기 → 입력 → Escape → 저장). 패널 안에 진짜 발행 버튼이 있으므로 가드가 전제 ─────
    await insertTags(d.tags || []);

    // ───── 임시저장 ─────
    await assertGuard(page, '저장 직전');
    if (DRY_RUN) {
      rec('임시저장', 'skip', '--dry-run: 저장 클릭 생략');
    } else {
      let btn = F.locator('button[class*="save_btn"]').filter({ visible: true }).first();
      if (!(await btn.count())) btn = F.getByRole('button', { name: '저장', exact: true }).first();
      await safeClick(btn);
      await page.waitForTimeout(3500);
      const toast = await F.evaluate(() => document.body.innerText.match(/저장(되었|됐|완료)[^\n]{0,20}/)?.[0] || '').catch(() => '');
      rec('임시저장', true, toast ? `응답: ${toast}` : '클릭 완료(토스트 미확인 — 덤프로 검증)');
    }

    // ───── 이중 검증: (a) 스크린샷 (b) 전문 텍스트 덤프 대조 ─────
    await page.screenshot({ path: `${base}.png` }).catch(() => {});
    const dump = await F.evaluate(() => {
      const t = (document.querySelector('.se-title-text') || {}).innerText || '';
      const body = (document.querySelector('.se-main-container') || document.body).innerText || '';
      return { title: t.trim(), body };
    });
    fs.writeFileSync(`${base}.dump.txt`, `TITLE: ${dump.title}\n\n${dump.body}\n`);
    verifyDump(d, dump);

    const blocked = await F.evaluate(() => window.__publishBlocked || 0).catch(() => 0);
    printResults(blocked, base);
    const bad = Object.values(results).some((r) => r.ok === false);
    if (KEEP_OPEN) { console.log('--keep-open: 브라우저 유지 중 (Ctrl+C로 종료)'); await new Promise(() => {}); }
    await context.close();
    process.exit(bad ? 2 : 0);

    // ───────── 내부 함수들 (호이스팅으로 위에서 사용) ─────────
    async function insertVideo(v) {
      try {
        await ensureEmptyParagraph();
        // 동영상 툴바 버튼 클래스는 미검증 추정 — 실패 시 probe
        await safeClick(F.locator('button[class*="video"][class*="toolbar-button"]'));
        await F.waitForSelector('.se-popup-video-upload', { timeout: 10000 });
        const [chooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 10000 }),
          safeClick(F.locator('.se-popup-video-upload button.nvu_btn_append.nvu_local')),
        ]);
        await chooser.setFiles(path.resolve(ROOT, v.path));
        const titleInput = F.locator('.se-popup-video-upload input[placeholder*="제목"]').first();
        await titleInput.waitFor({ timeout: 30000 });
        await titleInput.fill(v.title.slice(0, 40));
        // 업로드 완료 대기 (수 분) — 확인 버튼 활성화로 판단
        const confirm = F.locator('.se-popup-video-upload button.se-popup-button-confirm, .se-popup-video-upload button.se-popup-button-ok').first();
        let ready = false;
        for (let t = 0; t < 360; t++) { // 최대 6분
          if (await confirm.isEnabled().catch(() => false)) { ready = true; break; }
          await page.waitForTimeout(1000);
        }
        if (!ready) throw new Error('영상 업로드 완료 대기 시간 초과');
        await safeClick(confirm);
        await page.waitForTimeout(1500);
        const how = await closePopup('.se-popup-video-upload', 'button.nvu_btn_close');
        await ensureTrailingParagraph();
        await focusEnd();
        const cnt = await F.locator('.se-component.se-video').count();
        rec('동영상', cnt > 0, `삽입 ${cnt}개 / 팝업 ${how}`);
      } catch (e) {
        await closePopup('.se-popup-video-upload', 'button.nvu_btn_close').catch(() => {});
        rec('동영상', false, `❗수동 필요: ${e.message}`);
        await focusEnd().catch(() => {});
      }
    }

    async function insertPlace(pl) {
      try {
        await focusEnd();
        await ensureEmptyParagraph();
        // 지도 툴바 버튼/팝업/결과 셀렉터는 일부 미검증 추정 — 실패 시 probe
        await safeClick(F.locator('button[class*="map"][class*="toolbar-button"], button[class*="place"][class*="toolbar-button"]'));
        const pop = F.locator('[class*="se-popup-place"], [class*="se-popup-map"], .se-popup').filter({ visible: true }).last();
        await pop.waitFor({ timeout: 10000 });
        const input = pop.locator('input[type="text"], input:not([type])').first();
        await input.fill(pl.query);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(2000);
        const items = pop.locator('li').filter({ has: pop.locator('button', { hasText: '추가' }) });
        const n = await items.count();
        if (n === 0) { rec('지도', false, `❗수동 필요: "${pl.query}" 검색 결과 0건 — 지도를 수동 첨부하세요`); await closePopup('.se-popup', 'button[class*="close"]'); return; }
        const norm = (s) => (s || '').replace(/\s+/g, '');
        const want = norm(pl.name || pl.query);
        const texts = [];
        for (let k = 0; k < n; k++) texts.push(norm(await items.nth(k).innerText()));
        let idx = texts.findIndex((t) => t.split('\n')[0] === want);
        if (idx < 0) idx = texts.findIndex((t) => t.includes(want));
        if (idx < 0) idx = 0;
        const item = items.nth(idx);
        await item.hover(); // "추가" 버튼은 hover 전 not visible
        const addBtn = item.locator('button', { hasText: '추가' }).first();
        try { await addBtn.click({ timeout: 4000 }); }
        catch (e) { await addBtn.evaluate((el) => el.click()); } // 폴백: DOM 직접 click
        await page.waitForTimeout(600);
        const ok = F.locator('.se-popup button.se-popup-button-confirm').filter({ visible: true }).first(); // "추가" 전엔 disabled
        await ok.waitFor({ timeout: 5000 });
        if (await ok.isEnabled()) await safeClick(ok);
        await page.waitForTimeout(1200);
        const how = await closePopup('.se-popup', 'button[class*="close"]'); // Escape 불가 → 닫기 버튼
        const cnt = await F.locator('.se-component.se-placesMap, .se-component[class*="map"], .se-component[class*="place"]').count();
        rec('지도', cnt > 0, `후보 ${n}개 중 ${idx + 1}번째 선택 / 팝업 ${how} / 컴포넌트 ${cnt}`);
      } catch (e) {
        await closePopup('.se-popup', 'button[class*="close"]').catch(() => {});
        rec('지도', false, `❗수동 필요: ${e.message}`);
      }
    }

    async function insertTags(tags) {
      if (!tags.length) { rec('태그', 'skip', 'tags 없음'); return; }
      try {
        const opener = F.locator(`button[class*="publish_btn"]:not([data-testid="seOnePublishBtn"])`).filter({ visible: true }).first();
        if (!(await opener.count())) throw new Error('발행 패널 열기 버튼을 찾지 못함 (패널을 여는 것일 뿐 발행하지 않음)');
        await safeClick(opener);
        const tagInput = F.locator('input#tag-input');
        await tagInput.waitFor({ timeout: 10000 });
        await assertGuard(page, '발행 패널 오픈 후'); // 진짜 발행 버튼이 노출된 상태 — 가드 재확인
        for (const raw of tags.slice(0, 30)) {
          const tag = raw.replace(/^#+/, '').trim();
          if (!tag) continue;
          await tagInput.click();
          await page.keyboard.insertText(tag);
          await page.keyboard.press('Enter'); // 칩 확정
          await page.waitForTimeout(150);
        }
        // 검증: 태그 영역 텍스트를 #로 쪼개 센다 (칩 클래스는 해시가 바뀌므로 의존 금지)
        const area = await F.evaluate(() => {
          const el = document.querySelector('input#tag-input');
          let p = el && el.parentElement;
          for (let i = 0; i < 5 && p; i++, p = p.parentElement) if (/tag/i.test(p.className || '')) return p.innerText || '';
          return (el && el.parentElement && el.parentElement.innerText) || '';
        });
        const count = area.split('#').length - 1;
        await page.keyboard.press('Escape'); // 패널만 닫기
        await page.waitForTimeout(600);
        const closed = !(await tagInput.isVisible().catch(() => false));
        const want = Math.min(tags.length, 30);
        rec('태그', count >= want && closed, `칩 ${count}/${want}개, 패널 ${closed ? '닫힘' : '❗열려 있음 — 수동으로 닫기'}`);
      } catch (e) {
        rec('태그', false, `❗수동 필요: ${e.message}`);
        await page.keyboard.press('Escape').catch(() => {});
      }
    }
  } catch (err) {
    console.error('\n❗ 실행 실패:', err.message);
    try { await page.screenshot({ path: `${base}.error.png` }); console.error('  스크린샷: ' + path.relative(ROOT, `${base}.error.png`)); } catch (e) {}
    console.error('  → 추측으로 고치지 말고 `node scripts/probe_selectors.js`로 실제 DOM을 실측하세요. 3회 실패하면 수동 붙여넣기 원고를 출력합니다.');
    await context.close().catch(() => {});
    process.exit(1);
  }
})();

// 덤프 전문 대조 (공백 제거 후 포함 여부 + 순서)
function verifyDump(d, dump) {
  const norm = (s) => (s || '').replace(/[\s​]+/g, '');
  const body = norm(dump.body);
  let cursor = 0, missing = [], misorder = [];
  for (const b of d.blocks) {
    if (!['text', 'subtitle', 'quote'].includes(b.type)) continue;
    for (const line of b.text.split('\n')) {
      const n = norm(line);
      if (!n) continue;
      const at = body.indexOf(n, 0);
      if (at < 0) { missing.push(line.slice(0, 30)); continue; }
      const ordered = body.indexOf(n, cursor);
      if (ordered < 0) misorder.push(line.slice(0, 30)); else cursor = ordered + n.length;
    }
  }
  const titleOK = norm(dump.title) === norm(d.title);
  rec('제목 덤프 대조', titleOK, titleOK ? '일치' : `에디터="${dump.title}"`);
  rec('본문 덤프 대조', missing.length === 0 && misorder.length === 0,
    missing.length || misorder.length ? `누락 ${missing.length}줄 [${missing.slice(0, 3).join(' | ')}] / 순서 어긋남 ${misorder.length}줄` : '전 문장 일치·순서 일치');
}

function printResults(blocked, base) {
  console.log('\n══════ 자동 처리 결과 ══════');
  for (const [k, r] of Object.entries(results)) {
    const mark = r.ok === 'skip' ? '－' : r.ok ? '✔' : '❗수동 필요';
    console.log(`${mark.padEnd(7)} ${k}: ${r.note}`);
  }
  console.log(`발행 차단 가드가 막은 발행 클릭 시도: ${blocked}회`);
  console.log(`스크린샷: ${path.relative(ROOT, base)}.png / 텍스트 덤프: ${path.relative(ROOT, base)}.dump.txt`);
  console.log(DRY_RUN ? '※ --dry-run 이라 저장하지 않았습니다.' : '※ 임시저장까지만 했습니다. 발행은 사람이 직접 하세요.');
  console.log('════════════════════════════');
}

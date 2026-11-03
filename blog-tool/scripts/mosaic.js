#!/usr/bin/env node
// 사진 개인정보 모자이크. 원본은 절대 덮어쓰지 않고 input/photos/_mosaic/ 에 처리본을 만든다.
//
// 사용: node scripts/mosaic.js drafts/xxx.mosaic.json
// spec 형식 (좌표는 0~1 상대값, EXIF 회전 보정 후 = 사람 눈에 보이는 화면 기준, 상하좌우 15% 여유를 포함해서 적을 것):
// {
//   "images": [
//     { "src": "input/photos/4.webp",
//       "regions": [ { "x": 0.05, "y": 0.10, "w": 0.30, "h": 0.25, "reason": "일행 얼굴" } ] }
//   ],
//   "block": 14          // 선택: 모자이크 블록 수(짧은 변 기준 작을수록 거칠다). 기본 14
// }
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'input', 'photos', '_mosaic');

async function processImage(item, blockCount) {
  const src = path.resolve(ROOT, item.src);
  if (!fs.existsSync(src)) throw new Error(`원본 없음: ${item.src}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const base = path.basename(src, path.extname(src));
  const out = path.join(OUT_DIR, `${base}.jpg`);
  if (path.resolve(out) === src) throw new Error('원본 덮어쓰기 금지');

  // 1) EXIF 회전 보정을 먼저 굽는다 → 이후 좌표는 보이는 화면 기준
  const { data: baseBuf, info } = await sharp(src).rotate().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;

  const composites = [];
  for (const r of item.regions || []) {
    const left = Math.max(0, Math.floor(r.x * W));
    const top = Math.max(0, Math.floor(r.y * H));
    const width = Math.min(W - left, Math.ceil(r.w * W));
    const height = Math.min(H - top, Math.ceil(r.h * H));
    if (width < 2 || height < 2) throw new Error(`영역이 너무 작거나 이미지 밖: ${JSON.stringify(r)}`);

    // 2) sharp는 한 파이프라인에 resize 1회만 적용 → 축소→버퍼→확대(nearest) 2단계 분리
    const factor = Math.max(1, Math.round(Math.min(width, height) / blockCount));
    const smallW = Math.max(1, Math.round(width / factor));
    const smallH = Math.max(1, Math.round(height / factor));
    const smallBuf = await sharp(baseBuf)
      .extract({ left, top, width, height })
      .resize(smallW, smallH, { kernel: 'cubic' })
      .toBuffer();
    const bigBuf = await sharp(smallBuf)
      .resize(width, height, { kernel: 'nearest', fit: 'fill' })
      .toBuffer();
    composites.push({ input: bigBuf, left, top });
  }

  await sharp(baseBuf).composite(composites).jpeg({ quality: 92 }).toFile(out);
  return { out: path.relative(ROOT, out), regions: composites.length, size: `${W}x${H}` };
}

(async () => {
  const specPath = process.argv[2];
  if (!specPath) { console.error('사용: node scripts/mosaic.js <spec.json>'); process.exit(1); }
  const spec = JSON.parse(fs.readFileSync(path.resolve(specPath), 'utf8'));
  const blockCount = spec.block || 14;
  let total = 0;
  for (const item of spec.images || []) {
    const res = await processImage(item, blockCount);
    total += res.regions;
    const reasons = (item.regions || []).map((r) => r.reason || '사유 미기재').join(', ');
    console.log(`✔ ${item.src} → ${res.out} (${res.size}, ${res.regions}영역: ${reasons})`);
  }
  console.log(`처리 완료: ${(spec.images || []).length}장 / ${total}영역. 처리본을 Read로 열어 실제로 가려졌는지 반드시 확인하세요.`);
})().catch((e) => { console.error('❗', e.message); process.exit(1); });

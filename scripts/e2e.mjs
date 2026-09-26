// ブラウザでの動作確認（E2E）。docs/ を GitHub Pages と同じくヘッダーなしで配信し、Chromium で一通り操作する。
// 準備: npm i --no-save playwright && npx playwright install chromium
// 実行: npm run e2e -- [画像ファイル]   （省略時は合成画像を使う）
//       E2E_SCREENSHOTS=<dir> を付けるとスクリーンショットを保存する
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, extname, join, resolve, sep } from "node:path";
import { chromium } from "playwright";
import { formatBytes } from "../docs/image-core.js";

const ROOT = resolve(import.meta.dirname, "../docs");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".wasm": "application/wasm",
};

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const file = join(ROOT, path.endsWith("/") ? `${path}index.html` : path);
  try {
    if (!file.startsWith(ROOT + sep)) throw new Error("outside root");
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
}).listen(0);
const url = `http://localhost:${server.address().port}/`;
const shots = process.env.E2E_SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  // 初回はリロードを挟んで cross-origin isolated になる
  await page.goto(url);
  let isolated = false;
  for (let i = 0; i < 50 && !isolated; i++) {
    isolated = await page.evaluate(() => window.crossOriginIsolated).catch(() => false);
    if (!isolated) await page.waitForTimeout(200);
  }
  assert.ok(isolated, "Service Worker で cross-origin isolated になっていない");
  if (shots) await page.screenshot({ path: join(shots, "1-start.png") });

  // 画像を読み込む
  const input = process.argv[2]
    ? { name: basename(process.argv[2]), mimeType: mimeOf(process.argv[2]), buffer: await readFile(process.argv[2]) }
    : { name: "sample.png", mimeType: "image/png", buffer: await syntheticImage(page) };
  await page.setInputFiles("#file-input", input);
  await page.waitForSelector("#workspace:not([hidden])");
  const { width, height } = await page.evaluate(() => {
    const c = document.querySelector("#result-canvas");
    return { width: c.width, height: c.height };
  });
  console.log(`読み込み: ${input.name} ${width}×${height}`);

  // 背景を透過
  await page.click("label:has(#opt-remove-bg)");
  await page.waitForFunction(() => document.querySelector("#bg-info").textContent !== "", null, { timeout: 180000 });
  const info = await page.textContent("#bg-info");
  console.log(`背景透過: ${info}`);
  assert.match(info, /CPU（([2-9]|\d{2,}) スレッド）|GPU/, "マルチスレッドか GPU で処理されていない");
  if (!process.argv[2]) {
    const [corner, center] = await pixels(page, [
      [5, 5],
      [width / 2, height / 2],
    ]);
    assert.ok(corner[3] < 20, `背景が透明になっていない: ${corner}`);
    assert.ok(center[3] > 235, `被写体が残っていない: ${center}`);
  }
  if (shots) await page.screenshot({ path: join(shots, "2-removed.png") });

  // 色を反転
  const [before] = await pixels(page, [[width / 2, height / 2]]);
  await page.click("label:has(#opt-invert)");
  const [after] = await pixels(page, [[width / 2, height / 2]]);
  assert.deepEqual(
    after.slice(0, 3),
    before.slice(0, 3).map((v) => 255 - v),
  );
  assert.equal(after[3], before[3]);
  await page.click("label:has(#opt-invert)");

  // 各形式で書き出す
  const signatures = {
    png: [0x89, 0x50, 0x4e, 0x47],
    jpeg: [0xff, 0xd8, 0xff],
    webp: [0x52, 0x49, 0x46, 0x46],
    bmp: [0x42, 0x4d],
    ico: [0x00, 0x00, 0x01, 0x00],
  };
  for (const [id, magic] of Object.entries(signatures)) {
    await page.click(`label:has(input[name="format"][value="${id}"])`);
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#download-btn")]);
    const bytes = await readFile(await download.path());
    assert.deepEqual([...bytes.subarray(0, magic.length)], magic, `${id} のシグネチャが違う`);
    // 事前に表示した書き出しサイズと、実際にダウンロードしたファイルが一致する
    await page.waitForFunction(() => document.querySelector("#export-size").textContent !== "");
    assert.equal(await page.textContent("#export-size"), formatBytes(bytes.length), `${id} の表示サイズが違う`);
    if (id === "png") {
      assert.equal(bytes.readUInt32BE(16), width);
      assert.equal(bytes.readUInt32BE(20), height);
      assert.equal(bytes[25], 6, "PNG がアルファ付き（RGBA）でない");
    }
    console.log(`書き出し: ${download.suggestedFilename()} ${bytes.length} bytes`);
  }
  await page.click('label:has(input[name="format"][value="png"])');

  // 元画像の表示に切り替え
  await page.click('[data-view="source"]');
  assert.ok(await page.isVisible("#source-canvas"));
  await page.click('[data-view="result"]');
  if (shots) await page.screenshot({ path: join(shots, "3-final.png"), fullPage: true });

  assert.deepEqual(errors, [], "コンソールにエラーが出ている");
  console.log("E2E: OK");
} finally {
  await browser.close();
  server.close();
}

function mimeOf(file) {
  const ext = extname(file).slice(1).toLowerCase();
  return { jpg: "image/jpeg", jpeg: "image/jpeg", svg: "image/svg+xml" }[ext] || `image/${ext}`;
}

/** 灰色の背景にオレンジの球がある 800×600 の PNG をブラウザ内で作る */
async function syntheticImage(page) {
  const base64 = await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 800;
    c.height = 600;
    const ctx = c.getContext("2d");
    const bg = ctx.createLinearGradient(0, 0, 0, 600);
    bg.addColorStop(0, "#e9ecef");
    bg.addColorStop(1, "#ced4da");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 800, 600);
    const ball = ctx.createRadialGradient(340, 240, 20, 400, 300, 190);
    ball.addColorStop(0, "#ffd08a");
    ball.addColorStop(1, "#e8590c");
    ctx.fillStyle = ball;
    ctx.beginPath();
    ctx.arc(400, 300, 190, 0, Math.PI * 2);
    ctx.fill();
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  });
  return Buffer.from(base64, "base64");
}

/** 結果 canvas の指定座標の RGBA */
function pixels(page, points) {
  return page.evaluate((pts) => {
    const ctx = document.querySelector("#result-canvas").getContext("2d");
    return pts.map(([x, y]) => [...ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data]);
  }, points);
}

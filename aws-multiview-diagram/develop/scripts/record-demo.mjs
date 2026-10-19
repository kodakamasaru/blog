// 記事用のデモ GIF と静止画を撮る。各ステップでパネルの表示を待ち合わせるので、動作確認も兼ねている。
// 使い方: npm run build && npm run preview（別ターミナル）→ npm run record
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://localhost:5178/?e2e';
const IMG_DIR = new URL('../../img/', import.meta.url).pathname;
const VIDEO_DIR = new URL('../test-results/video/', import.meta.url).pathname;
const VIEWPORT = { width: 1280, height: 800 };
const GIF_WIDTH = 960;
const GIF_FPS = 8;
const GIF_COLORS = 64;

// ヘッドレスでは録画にカーソルが映らないので、見やすい丸いカーソルを描く
const FAKE_CURSOR = () => {
  window.addEventListener('DOMContentLoaded', () => {
    const dot = document.createElement('div');
    Object.assign(dot.style, {
      position: 'fixed', zIndex: 9999, width: '22px', height: '22px', marginLeft: '-11px', marginTop: '-11px',
      borderRadius: '50%', border: '2px solid #202838', background: 'rgba(255, 214, 10, 0.55)',
      pointerEvents: 'none', transition: 'transform 120ms', left: '-50px', top: '-50px',
    });
    document.body.append(dot);
    document.addEventListener('mousemove', (e) => { dot.style.left = `${e.clientX}px`; dot.style.top = `${e.clientY}px`; });
    document.addEventListener('mousedown', () => { dot.style.transform = 'scale(0.7)'; });
    document.addEventListener('mouseup', () => { dot.style.transform = 'scale(1)'; });
  });
};

async function waitIdle(page, ms = 400) {
  await page.waitForFunction(() => window.__tfscope && !document.getElementById('cy').classList.contains('is-switching'));
  await page.waitForTimeout(ms);
}

async function nodeBox(page, id) {
  return page.evaluate((nodeId) => {
    const node = window.__tfscope.cy.getElementById(nodeId);
    if (node.empty()) throw new Error(`node not found: ${nodeId}`);
    const bb = node.renderedBoundingBox({ includeLabels: false, includeOverlays: false });
    const rect = document.getElementById('cy').getBoundingClientRect();
    return { x: rect.left + (bb.x1 + bb.x2) / 2, y: rect.top + (bb.y1 + bb.y2) / 2, top: rect.top + bb.y1 };
  }, id);
}

async function glide(page, x, y) {
  await page.mouse.move(x, y, { steps: 18 });
  await page.waitForTimeout(220);
}

async function clickNode(page, id) {
  const { x, y } = await nodeBox(page, id);
  await glide(page, x, y);
  await page.mouse.click(x, y);
}

async function clickText(page, selector, text) {
  const target = page.locator(selector, { hasText: text }).first();
  const box = await target.boundingBox();
  await glide(page, box.x + box.width / 2, box.y + box.height / 2);
  await target.click();
}

async function expectPanel(page, text) {
  await page.locator('#panel', { hasText: text }).waitFor({ timeout: 5000 });
}

async function scenario(page) {
  await page.goto(`${BASE}#view=network`);
  await waitIdle(page, 1200);

  // 1. NW 視点で ECS をクリック → 詳細が開く
  await clickNode(page, 'aws_ecs_service.api');
  await expectPanel(page, 'NW フローでのつながり');
  await page.waitForTimeout(1600);

  // 2. 選択したまま IAM 視点へ → 同じ ECS が IAM の文脈で強調される
  await clickText(page, '.view-tab', 'IAM フロー');
  await waitIdle(page, 1400);
  await expectPanel(page, 'タスクロール');

  // 3. ロールをクリック → そのロールが何をできるかだけが浮かび上がる
  await clickNode(page, 'aws_iam_role.api_task');
  await expectPanel(page, 's3:PutObject');
  await page.waitForTimeout(1800);

  // 4. ECS を選び直してデータフロー視点へ
  await clickNode(page, 'aws_ecs_service.api');
  await page.waitForTimeout(500);
  await clickText(page, '.view-tab', 'データフロー');
  await waitIdle(page, 1400);

  // 5. 推定したエッジを開いて、根拠になった IaC を見る
  await clickText(page, '.linkish', 'photos');
  await expectPanel(page, 'なぜ推定なのか');
  await page.waitForTimeout(1200);
  await clickText(page, '.linkish', 'タスクロールのポリシーの中身');
  await expectPanel(page, 'data.aws_iam_policy_document.api_task');
  await page.waitForTimeout(2200);

  // 6. NW 視点に戻って、サブネット層をダブルクリックで折りたたむ
  await page.keyboard.press('Escape');
  await page.keyboard.press('1');
  await waitIdle(page, 900);
  const tier = await nodeBox(page, 'tier:aws_vpc.main:app');
  await glide(page, tier.x, tier.top + 10);
  await page.mouse.dblclick(tier.x, tier.top + 10);
  await expectPanel(page, '展開する');
  await waitIdle(page, 1800);
}

async function stills(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2 });
  const shots = [
    ['view-network.png', '#view=network'],
    ['node-detail.png', '#view=network&node=aws_db_instance.main'],
    ['view-iam.png', '#view=iam&node=aws_iam_role.thumbnail'],
    ['view-data.png', '#view=data'],
  ];
  for (const [file, hash] of shots) {
    await page.goto(`${BASE}&${file}${hash}`);
    await waitIdle(page, 900);
    await page.screenshot({ path: join(IMG_DIR, file) });
  }
  await page.goto(`${BASE}&edge#view=data&node=aws_lambda_function.thumbnail`);
  await waitIdle(page, 400);
  await page.locator('.linkish', { hasText: 'uploads' }).first().click();
  await expectPanel(page, 'なぜ推定なのか');
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(IMG_DIR, 'edge-detail.png') });
  await page.close();
}

async function main() {
  mkdirSync(IMG_DIR, { recursive: true });
  rmSync(VIDEO_DIR, { recursive: true, force: true });
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome' });
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, recordVideo: { dir: VIDEO_DIR, size: VIEWPORT } });
    await context.addInitScript(FAKE_CURSOR);
    const page = await context.newPage();
    const started = Date.now();
    await page.goto(`${BASE}#view=network`);
    await waitIdle(page, 0);
    const loadSeconds = (Date.now() - started) / 1000;
    await scenario(page);
    await context.close();

    const video = join(VIDEO_DIR, readdirSync(VIDEO_DIR).find((f) => f.endsWith('.webm')));
    const filter = `fps=${GIF_FPS},scale=${GIF_WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${GIF_COLORS}:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`;
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(loadSeconds + 0.3), '-i', video, '-vf', filter, join(IMG_DIR, 'demo.gif')]);

    await stills(browser);
    process.stdout.write(`ok: ${join(IMG_DIR, 'demo.gif')}\n`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  process.stderr.write(`record-demo: ${err.stack ?? err}\n`);
  process.exit(1);
});

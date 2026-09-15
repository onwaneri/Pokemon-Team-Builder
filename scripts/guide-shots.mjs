/**
 * Captures the guide's annotated screenshots from a running dev server.
 *
 *   npm run dev                      (in another terminal, http://localhost:3000)
 *   node scripts/guide-shots.mjs     [baseUrl]  [playwrightDir]  [desktop,phone]
 *
 * The third argument limits the run to those profiles (default both); the other profile's
 * entries in guideShots.json are kept.
 *
 * Playwright is not a project dependency: point the second argument at a directory where
 * `npm i playwright && npx playwright install chromium` was run (default: a scratch dir).
 * Writes two screenshot sets, JPEG q82: public/guide/<slide>.jpg from a 1400×900 desktop viewport
 * and public/guide/m/<slide>.jpg from a 390×844 phone viewport at 2× (the phone layout: compact
 * header, stacked panels, the assistant as a sheet). src/components/guideShots.json records each
 * image's size so GuideTour.tsx can reserve the right aspect ratio; the copy there is hand-written
 * and keyed by slide id. Re-run whenever the UI changes.
 *
 * The run uses the free AI allowance for one assistant reply and one damage calc so the
 * screenshots show real output. Nothing is left behind: the seeded teams live in the headless
 * browser's own storage.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const PW_DIR = process.argv[3] ?? '/tmp/claude-501/shots';
const ONLY = (process.argv[4] ?? 'desktop,phone').split(',');
const require = createRequire(path.join(PW_DIR, 'package.json'));
const { chromium } = require('playwright');

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_ROOT = path.join(ROOT, 'public', 'guide');
const JSON_OUT = path.join(ROOT, 'src', 'components', 'guideShots.json');
const PROFILES = {
  desktop: { viewport: { width: 1400, height: 900 }, scale: 1, dir: OUT_ROOT },
  phone: { viewport: { width: 390, height: 844 }, scale: 2, dir: path.join(OUT_ROOT, 'm') },
};

const SUN = `Torkoal @ Charcoal
Ability: Drought
Level: 50
EVs: 32 HP / 32 SpA / 2 SpD
Modest Nature
- Eruption
- Weather Ball
- Solar Beam
- Protect

Charizard @ Charizardite Y
Ability: Blaze
Level: 50
EVs: 2 HP / 32 SpA / 32 Spe
Timid Nature
- Heat Wave
- Weather Ball
- Air Slash
- Protect

Incineroar @ Sitrus Berry
Ability: Intimidate
Level: 50
EVs: 32 HP / 32 Atk / 2 SpD
Adamant Nature
- Fake Out
- Flare Blitz
- Knock Off
- Parting Shot

Rillaboom @ Miracle Seed
Ability: Grassy Surge
Level: 50
EVs: 32 HP / 32 Atk / 2 SpD
Adamant Nature
- Fake Out
- Grassy Glide
- Wood Hammer
- U-turn

Salamence @ Salamencite
Ability: Intimidate
Level: 50
EVs: 2 HP / 32 Atk / 32 Spe
Adamant Nature
- Hyper Voice
- Tailwind
- Double-Edge
- Protect

Milotic @ Leftovers
Ability: Competitive
Level: 50
EVs: 32 HP / 32 SpA / 2 SpD
Modest Nature
- Scald
- Icy Wind
- Recover
- Protect
`;

const TAILWIND = `Dragonite @ Dragoninite
Ability: Multiscale
Level: 50
EVs: 2 HP / 32 Atk / 32 Spe
Adamant Nature
- Extreme Speed
- Tailwind
- Ice Spinner
- Protect

Whimsicott @ Focus Sash
Ability: Prankster
Level: 50
EVs: 32 HP / 2 SpA / 32 Spe
Timid Nature
- Tailwind
- Moonblast
- Encore
- Protect

Indeedee-F @ Psychic Seed
Ability: Psychic Surge
Level: 50
EVs: 32 HP / 32 Def / 2 SpD
Bold Nature
- Follow Me
- Helping Hand
- Psychic
- Protect

Garchomp @ Garchompite Z
Ability: Rough Skin
Level: 50
EVs: 2 HP / 32 Atk / 32 Spe
Jolly Nature
- Dragon Claw
- Stomping Tantrum
- Rock Slide
- Protect

Swampert @ Swampertite
Ability: Torrent
Level: 50
EVs: 32 HP / 32 Atk / 2 SpD
Adamant Nature
- Wave Crash
- Earthquake
- Ice Punch
- Protect

Incineroar @ Sitrus Berry
Ability: Intimidate
Level: 50
EVs: 32 HP / 2 Atk / 32 SpD
Careful Nature
- Fake Out
- Flare Blitz
- Knock Off
- Parting Shot
`;

async function importTeam(paste) {
  const r = await fetch(`${BASE}/api/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paste, regulation: 'reg-m-c' }) });
  const d = await r.json();
  if (!r.ok) throw new Error(`import failed: ${d.error}`);
  const slots = Array(6).fill(null);
  for (const m of d.team) slots[m.slot - 1] = m;
  return { slots, issues: d.issues ?? [] };
}

function savedTeam(id, name, slots, blurb, ageMs) {
  const now = Date.now() - ageMs;
  return { id, name, team: slots, blurb, blurbHash: 'guide', createdAt: now, updatedAt: now, regulation: 'reg-m-c' };
}

const shots = fs.existsSync(JSON_OUT) ? JSON.parse(fs.readFileSync(JSON_OUT, 'utf8')) : {};
for (const k of Object.keys(PROFILES)) if (ONLY.includes(k)) shots[k] = {};
let profileName = 'desktop';
let VIEWPORT = PROFILES.desktop.viewport;

/** Screenshot the viewport (or `opts.clip`), scrolled to the top unless `opts.keepScroll`. */
async function capture(page, id, opts = {}) {
  // The workspace scrolls inside a nested container, not the window: reset every scrolled element.
  if (!opts.keepScroll) await page.evaluate(() => { window.scrollTo(0, 0); for (const el of document.querySelectorAll('*')) if (el.scrollTop) el.scrollTop = 0; });
  await page.waitForTimeout(opts.settle ?? 700);
  const clip = opts.clip ?? { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height };
  const dir = PROFILES[profileName].dir;
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${id}.jpg`), type: 'jpeg', quality: 82, clip });
  shots[profileName][id] = { width: Math.round(clip.width), height: Math.round(clip.height) };
  console.log(`[${profileName}] captured ${id}`);
}

/** The Next.js dev overlay badge must not appear in the shots. */
async function hideDevBadge(page) {
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
}

const sun = await importTeam(SUN);
const tw = await importTeam(TAILWIND);
for (const [n, t] of [['sun', sun], ['tailwind', tw]]) if (t.issues.length) console.warn(`${n} import issues:`, t.issues.map((i) => i.message));

const teams = [
  savedTeam('guide-sun', 'Torkoal Sun', sun.slots, 'Sun offense built around Torkoal and Mega Charizard Y. Incineroar and Rillaboom give Fake Out and Intimidate support, Salamence sets Tailwind, and Milotic covers the late game with Icy Wind and Recover.', 3 * 3600e3),
  savedTeam('guide-tw', 'Dragonite Tailwind', tw.slots, 'Tailwind offense with two setters. Dragonite and Whimsicott open the speed window, Indeedee redirects, and Garchomp and Swampert bring two Megas so either can evolve depending on the matchup.', 26 * 3600e3),
];

const browser = await chromium.launch();

/** One full pass through the app in the given profile. */
async function run(name) {
  profileName = name;
  const profile = PROFILES[name];
  VIEWPORT = profile.viewport;
  const phone = name === 'phone';
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: profile.scale, colorScheme: 'dark', isMobile: phone, hasTouch: phone });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.evaluate((teams) => {
    localStorage.setItem('vgc-champions-teams-v1', JSON.stringify(teams));
    localStorage.setItem('vgc-champions-guide-v1', 'seen');
    localStorage.setItem('vgc-champions-ruleset-v1', 'reg-m-c');
    localStorage.removeItem('vgc-champions-chats-v1');
  }, teams);
  await page.reload();
  await hideDevBadge(page);
  await page.waitForSelector('text=Team Library');

  const openBtn = (team) => page.locator(`text=${team}`).locator('xpath=ancestor::div[.//button[text()="Open"]][1]').getByRole('button', { name: 'Open', exact: true });
  const ask = page.getByPlaceholder(/Ask, or change anything/);
  // On a phone the assistant is a full-screen sheet behind a floating button.
  const openAssistant = async () => { if (phone) { await page.getByRole('button', { name: /assistant/i }).click(); await ask.waitFor(); } };
  const closeAssistant = async () => { if (phone) { await page.getByRole('button', { name: 'Close', exact: true }).click(); await ask.waitFor({ state: 'hidden' }); } };

  // 1. Library
  await capture(page, 'library', phone ? {} : { clip: { x: 0, y: 0, width: VIEWPORT.width, height: 370 } });

  // 2. Overview of the editor
  await openBtn('Torkoal Sun').click();
  await page.getByRole('button', { name: 'Damage Calc' }).waitFor();
  if (!phone) await ask.waitFor();
  await capture(page, 'overview');

  // 3. Editor detail
  const speciesInput = page.locator('input[placeholder="Species"]').first();
  await speciesInput.scrollIntoViewIfNeeded();
  await page.evaluate(() => { for (const el of document.querySelectorAll('*')) if (el.scrollTop) el.scrollTop += 200; });
  await capture(page, 'editor', { keepScroll: true });

  // 4. Megas
  await page.locator('img[alt="Salamence-Mega"]').first().click();
  const toggle = page.getByRole('button', { name: /Show Salamence/ });
  await toggle.waitFor();
  if (phone) await toggle.scrollIntoViewIfNeeded();
  await capture(page, 'megas', { keepScroll: phone });

  // 5. Assistant: a real exchange
  await openAssistant();
  await ask.fill("Does Charizard-Mega-Y's Heat Wave OHKO a 32 HP Rillaboom in sun?");
  const chatReply = page.waitForResponse((r) => r.url().includes('/api/chat'), { timeout: 120_000 });
  await page.getByRole('button', { name: 'Send' }).click();
  await chatReply;
  await page.waitForTimeout(1200);
  await capture(page, 'assistant', { keepScroll: phone });
  await closeAssistant();

  // 6. Damage calc: a team member attacks a threat picked from the matchups strip
  await page.getByRole('button', { name: 'Damage Calc' }).click();
  await page.getByText('⚔ Attacker').first().waitFor();
  await page.locator('button:has-text("Charizard-Mega-Y")').first().click();
  await page.getByRole('button', { name: '⚔ Attacker' }).first().click();
  await page.waitForTimeout(600);
  await page.getByText(/Matchups for/).first().waitFor();
  // A matchup card (not a popular-set chip, whose tooltip also contains " @ ").
  const threat = page.getByRole('button', { name: /in current usage/ }).first();
  await threat.waitFor({ timeout: 20_000 });
  await threat.click();
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: '→' }).first().click();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /%$/.test(b.textContent.trim())), null, { timeout: 30_000 });
  await capture(page, 'calc');

  // 7. Speed tiers with the whole team and the suggested benchmarks in
  await page.getByRole('button', { name: 'Speed Tiers' }).click();
  await page.getByRole('button', { name: 'Tailwind (Mine)' }).waitFor();
  await page.getByRole('button', { name: 'Add all' }).first().click();
  await page.getByText(/Speed benchmarks for/i).first().waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Add all' }).last().click();
  await page.getByRole('button', { name: 'Tailwind (Mine)' }).click();
  await page.waitForTimeout(800);
  await capture(page, 'speed', phone ? {} : { clip: { x: 0, y: 0, width: VIEWPORT.width, height: 560 } });

  // 8. Export
  await page.getByRole('button', { name: 'Team', exact: true }).click();
  await page.getByRole('button', { name: 'Team actions' }).click();
  await page.getByText('Export', { exact: true }).click();
  await page.locator('textarea').first().waitFor();
  await capture(page, 'export');
  await page.mouse.click(8, VIEWPORT.height - 8);
  await page.locator('textarea').first().waitFor({ state: 'hidden' });

  // 9. Team builder: open the Tailwind team, drop it to two Pokémon, and let the builder fill it
  await page.getByRole('button', { name: '← Library' }).click();
  const discard = page.getByRole('button', { name: 'Discard' });
  if (await discard.isVisible().catch(() => false)) await discard.click();
  await openBtn('Dragonite Tailwind').click();
  await page.getByRole('button', { name: 'Damage Calc' }).waitFor();
  for (let i = 0; i < 4; i++) {
    const removes = page.locator('button[title="Remove"]');
    if (await removes.count() === 0) break;
    await removes.last().click();
    await page.waitForTimeout(200);
  }
  const builderInput = page.getByPlaceholder(/Fills|What kind of team/);
  await builderInput.waitFor();
  await builderInput.fill('keep the Tailwind plan, add a special attacker and redirection');
  const buildBtn = page.getByRole('button', { name: /Fill the other|Build team/ });
  await capture(page, 'builder');
  // Run it for real so the next slide shows the result (the input disappears once the team is full).
  await buildBtn.click();
  await page.getByRole('button', { name: 'Undo' }).waitFor({ timeout: 150_000 }).catch(() => console.warn('builder did not finish; capturing as is'));
  await page.waitForTimeout(800);
  await capture(page, 'builder-result');

  // 10. Options menu
  // The phone header shows only the gear; the title carries the name.
  await page.locator('button[title="Options"]').click();
  await page.getByRole('menuitem', { name: /AI access/ }).waitFor();
  await capture(page, 'options', phone ? {} : { clip: { x: 640, y: 0, width: 760, height: 380 } });

  await ctx.close();
}

for (const name of Object.keys(PROFILES)) if (ONLY.includes(name)) await run(name);
fs.writeFileSync(JSON_OUT, JSON.stringify(shots, null, 2) + '\n');
console.log('wrote', JSON_OUT);
await browser.close();

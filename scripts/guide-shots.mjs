/**
 * Captures the guide's annotated screenshots from a running dev server.
 *
 *   npm run dev                      (in another terminal, http://localhost:3000)
 *   node scripts/guide-shots.mjs     [baseUrl]  [playwrightDir]
 *
 * Playwright is not a project dependency: point the second argument at a directory where
 * `npm i playwright && npx playwright install chromium` was run (default: a scratch dir).
 * Writes public/guide/<slide>.jpg (1400×900 viewport, JPEG q80) and src/components/guideShots.json
 * with the callout boxes measured from the live DOM, as fractions of the image. GuideTour.tsx pairs
 * those boxes with its hand-written copy by slide id. Re-run whenever the UI changes.
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
const require = createRequire(path.join(PW_DIR, 'package.json'));
const { chromium } = require('playwright');

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = path.join(ROOT, 'public', 'guide');
const JSON_OUT = path.join(ROOT, 'src', 'components', 'guideShots.json');
const VIEWPORT = { width: 1400, height: 900 };

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

const shots = {};
/**
 * Screenshot the viewport (or `opts.clip`, a sub-rectangle) and record each callout's box as a
 * fraction of the captured image. The page is scrolled to the top first unless `opts.keepScroll`.
 */
async function capture(page, id, callouts, opts = {}) {
  // The workspace scrolls inside a nested container, not the window: reset every scrolled element.
  if (!opts.keepScroll) await page.evaluate(() => { window.scrollTo(0, 0); for (const el of document.querySelectorAll('*')) if (el.scrollTop) el.scrollTop = 0; });
  await page.waitForTimeout(opts.settle ?? 700);
  const clip = opts.clip ?? { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height };
  const boxes = [];
  for (const [label, locator] of callouts) {
    const box = await locator.first().boundingBox();
    if (!box) throw new Error(`${id}: no box for "${label}"`);
    boxes.push({ label, x: (box.x - clip.x) / clip.width, y: (box.y - clip.y) / clip.height, w: box.width / clip.width, h: box.height / clip.height });
  }
  await page.screenshot({ path: path.join(OUT_DIR, `${id}.jpg`), type: 'jpeg', quality: 82, clip });
  shots[id] = { width: Math.round(clip.width), height: Math.round(clip.height), boxes };
  console.log(`captured ${id} (${boxes.length} callouts)`);
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
const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, colorScheme: 'dark' });
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

const openBtn = (name) => page.locator(`text=${name}`).locator('xpath=ancestor::div[.//button[text()="Open"]][1]').getByRole('button', { name: 'Open', exact: true });
const card = (name) => page.locator(`text=${name}`).locator('xpath=ancestor::div[.//button[text()="Open"]][1]');
const ask = page.getByPlaceholder(/Ask, or change anything/);

// 1. Library (top strip only; the rest of the page is empty space)
await capture(page, 'library', [
  ['Start from scratch, or paste a Showdown team', page.getByRole('button', { name: 'Import Team' })],
  ['A saved team: overview, open, export, duplicate, delete', card('Torkoal Sun')],
  ['Options: Showdown account, AI access, sign in, this guide', page.getByRole('button', { name: 'Options' })],
], { clip: { x: 0, y: 0, width: VIEWPORT.width, height: 370 } });

// 2. Overview of the editor
await openBtn('Torkoal Sun').click();
await ask.waitFor();
await capture(page, 'overview', [
  ['Regulation: the whole app follows it', page.locator('header select')],
  ['Team, Damage Calc, Speed Tiers', page.getByRole('button', { name: 'Team', exact: true })],
  ['The six slots', page.locator('img[alt="Torkoal"]').first().locator('xpath=ancestor::div[count(.//img)>=6][1]')],
  ['The assistant, one conversation per team', ask.locator('xpath=ancestor::div[.//*[text()="AI Assistant"]][1]')],
]);

// 3. Editor detail
const speciesInput = page.locator('input[placeholder="Species"]').first();
await speciesInput.scrollIntoViewIfNeeded();
await page.evaluate(() => window.scrollBy(0, 200));
await capture(page, 'editor', [
  ['Species, ability, item, nature', speciesInput],
  ['Popular sets from Pikalytics apply with one click', page.locator('text=Popular sets').first()],
  ['Moves: sorted by usage, filtered by learnset', page.locator('input[placeholder="Move 1"]').first()],
  ['Stat Points: 0 to 32 per stat, 66 total, with nature toggles', page.locator('text=Stat Points').first()],
], { keepScroll: true });

// 4. Megas
await page.locator('img[alt="Salamence-Mega"]').first().click();
const toggle = page.getByRole('button', { name: /Show Salamence/ });
await toggle.waitFor();
await capture(page, 'megas', [
  ['Two Megas on one team is fine; one evolves per battle', page.locator('img[alt="Charizard-Mega-Y"]').first().locator('xpath=ancestor::div[count(.//img)>=6][1]')],
  ['Flip the view between base forme and Mega', toggle],
  ['The Mega Stone makes the slot the Mega forme', page.locator('input[placeholder="Item"]').first()],
]);

// 5. Assistant: a real exchange
await ask.fill("Does Charizard-Mega-Y's Heat Wave OHKO a 32 HP Rillaboom in sun?");
const chatReply = page.waitForResponse((r) => r.url().includes('/api/chat'), { timeout: 120_000 });
await page.getByRole('button', { name: 'Send' }).click();
await chatReply;
await page.waitForTimeout(1200);
await capture(page, 'assistant', [
  ['Ask, or tell it what to change on this screen', ask],
  ['Answers come from the engine and usage data; it names the tools it ran', ask.locator('xpath=ancestor::div[.//*[text()="AI Assistant"]][1]')],
]);

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
await capture(page, 'calc', [
  ['Attacker', page.getByText('⚔ Attacker').first()],
  ['Defender', page.getByText('🛡 Defender').first()],
  ['Click a move: rolls, KO chance, and the range appear', page.locator('input[placeholder="Move 1"]').first()],
  ['Matchups picked for the Pokémon you are building around', page.getByText(/Matchups for/).first()],
]);

// 7. Speed tiers with the whole team and the suggested benchmarks in
await page.getByRole('button', { name: 'Speed Tiers' }).click();
await page.getByRole('button', { name: 'Tailwind (Mine)' }).waitFor();
await page.getByRole('button', { name: 'Add all' }).first().click();
await page.getByText(/Speed benchmarks for/i).first().waitFor({ timeout: 20_000 });
await page.getByRole('button', { name: 'Add all' }).last().click();
await page.getByRole('button', { name: 'Tailwind (Mine)' }).click();
await page.waitForTimeout(800);
await capture(page, 'speed', [
  ['Tailwind, Trick Room, priority', page.getByRole('button', { name: 'Tailwind (Mine)' })],
  ['Benchmarks chosen from the format for your team', page.getByText(/Speed benchmarks for/i).first()],
  ['Add any opponent', page.getByPlaceholder(/Add opponent/)],
], { clip: { x: 0, y: 0, width: VIEWPORT.width, height: 560 } });

// 8. Export
await page.getByRole('button', { name: 'Team', exact: true }).click();
await page.getByRole('button', { name: 'Team actions' }).click();
await page.getByText('Export', { exact: true }).click();
await page.locator('textarea').first().waitFor();
await capture(page, 'export', [
  ['A Showdown paste; Stat Points go on the EVs line so Showdown reads them', page.locator('textarea').first()],
  ['Copy it, or share it as a PokePaste', page.getByRole('button', { name: /Share via PokePaste/ })],
]);
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
await capture(page, 'builder', [
  ['Describe the team, or what is missing', builderInput],
  ['Fills the open slots; every slot stays editable', buildBtn],
  ['Two Pokemon placed, four to go', page.locator('img[alt="Whimsicott"]').first().locator('xpath=ancestor::div[count(.//button)>=2][1]')],
]);
// Run it for real so the next slide shows the result (the input disappears once the team is full).
await buildBtn.click();
await page.getByRole('button', { name: 'Undo' }).waitFor({ timeout: 150_000 }).catch(() => console.warn('builder did not finish; capturing as is'));
await page.waitForTimeout(800);
await capture(page, 'builder-result', [
  ['What it built, and why, with Undo', page.getByRole('button', { name: 'Undo' }).first().locator('xpath=ancestor::div[2]')],
  ['The four new slots, each a full legal set', page.locator('img[alt="Whimsicott"]').first().locator('xpath=ancestor::div[count(.//img)>=6][1]')],
]);

// 10. Options menu (top-right region)
await page.getByRole('button', { name: 'Options' }).click();
await page.getByRole('menuitem', { name: /AI access/ }).waitFor();
await capture(page, 'options', [
  ['Link a Showdown account', page.getByRole('menuitem', { name: /Showdown account/ })],
  ['Built-in AI, or your own key', page.getByRole('menuitem', { name: /AI access/ })],
  ['This guide, any time', page.getByRole('menuitem', { name: /Guide/ })],
  ['Sign in to keep teams on your account', page.getByRole('menuitem', { name: /Sign in|Sign out/ })],
], { clip: { x: 640, y: 0, width: 760, height: 380 } });

fs.writeFileSync(JSON_OUT, JSON.stringify(shots, null, 2) + '\n');
console.log('wrote', JSON_OUT);
await browser.close();

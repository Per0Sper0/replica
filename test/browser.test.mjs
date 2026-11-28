import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startServer, account, scene, wav } from './helpers.mjs';

test('studio preserves failed recording, locks navigation, exports and submits without reload', { timeout: 60000 }, async t => {
  const server = await startServer(); t.after(() => server.close());
  const admin = await account(server, 'admin@example.test', true); const author = await account(server, 'actor@example.test');
  const source = await scene(server, author.cookie);
  await server.api(`/api/my/projects/${source.id}/submit`, { method: 'POST', cookie: author.cookie });
  await server.api(`/api/admin/videos/${source.id}/publish`, { method: 'POST', cookie: admin.cookie });
  let dub = (await server.api(`/api/my/projects/from/${source.id}`, { method: 'POST', cookie: author.cookie })).data;
  dub = (await server.api(`/api/my/projects/${dub.id}/segments/${dub.segments[0].id}/audio?fileName=take.wav`, { method: 'POST', cookie: author.cookie, body: wav() })).data;
  const browser = await chromium.launch({ ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : {}), headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  t.after(() => browser.close());
  const context = await browser.newContext({ permissions: ['microphone'] });
  await context.addCookies([{ name: 'replica_session', value: author.cookie.split('=')[1], url: server.base }]);
  const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  await page.goto(server.base + '/workspace/dub/?project=' + dub.id);
  await page.waitForFunction(() => state.project && document.querySelector('#line-video').readyState >= 2);
  await page.route('**/segments/*/audio?*', route => route.request().method() === 'POST' ? route.abort('failed') : route.continue());
  await page.click('#record-dub');
  await page.waitForFunction(() => state.recorder?.state === 'recording');
  const selectedBefore = await page.evaluate(() => state.index);
  await page.locator('[data-track-index="0"]').click();
  assert.equal(await page.evaluate(() => state.index), selectedBefore);
  assert.equal(await page.locator('#record-dub').isDisabled(), false);
  await page.waitForTimeout(150); await page.click('#record-dub');
  await page.waitForFunction(() => state.pendingTake && state.mode === null);
  assert.equal(await page.locator('#download-pending').isVisible(), true);
  await page.reload();
  await page.waitForFunction(() => Boolean(state.pendingTake));
  await page.unroute('**/segments/*/audio?*');
  await page.click('#retry-take');
  await page.waitForFunction(() => !state.pendingTake && state.segments.every(s => s.voiceFile));
  await page.locator('[data-track-index="1"]').click();
  await page.click('#next-line'); await page.click('#build-mix');
  await page.waitForFunction(() => Boolean(state.project.mixFile) && state.mode === null);
  assert.equal(await page.locator('#submit-dub').isVisible(), true);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.locator('.booth-screen').evaluate(node => node.getBoundingClientRect().width > 300));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewportSize({ width: 1280, height: 720 });
  const project = (await server.api('/api/my/projects', { cookie: author.cookie })).data.find(p => p.id === dub.id);
  const output = await fetch(server.base + project.mixUrl, { headers: { Cookie: author.cookie } }); const bytes = Buffer.from(await output.arrayBuffer()); assert.equal(bytes.readUInt32LE(24), 48000);
  await page.click('#submit-dub'); await page.waitForFunction(() => state.project.status === 'submitted');
  assert.equal(await page.locator('#record-dub').isDisabled(), true);
  assert.equal((await server.api(`/api/admin/videos/${dub.id}/publish`, { method: 'POST', cookie: admin.cookie })).status, 200);
  await page.goto(server.base + '/'); await page.locator('.card-action').click();
  assert.equal(await page.locator('[data-version]').count(), 1);
  await page.locator('[data-version]').click();
  assert.equal(await page.locator('#public-player').evaluate(node => node.muted), true);
  await page.locator('.dialog-close').click(); assert.equal(await page.locator('#version-audio').evaluate(node => node.paused), true);
  await page.goto(server.base + '/workspace/dub/'); await page.waitForFunction(() => state.user !== null);
  await page.click('#logout'); await page.waitForURL(server.base + '/');
  assert.deepEqual(errors, []);
});

test('editor autosaves millisecond timestamps and administrator can review', { timeout: 30000 }, async t => {
  const server = await startServer(); t.after(() => server.close());
  const author = await account(server, 'admin@example.test', true); const project = await scene(server, author.cookie);
  const browser = await chromium.launch({ ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : {}), headless: true }); t.after(() => browser.close());
  const context = await browser.newContext(); await context.addCookies([{ name: 'replica_session', value: author.cookie.split('=')[1], url: server.base }]);
  const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.base + '/workspace/segment/?project=' + project.id);
  await page.locator('[data-line-time="start"]').first().fill('00:00:00.250'); await page.locator('[data-line-text]').first().click();
  await page.waitForFunction(() => !state.dirty && !state.saving && state.projects[0].segments[0].start === .25);
  const stored = (await server.api('/api/my/projects', { cookie: author.cookie })).data[0]; assert.equal(stored.segments[0].start, .25);
  await page.goto(server.base + '/admin/'); await page.waitForFunction(() => state.videos.length > 0);
  assert.equal(await page.locator('#publish-review').isDisabled(), false);
  await page.click('#publish-review'); await page.waitForFunction(() => state.videos[0].published);
  assert.deepEqual(errors, []);
});

test('scene editor restores add controls after an autosave response or failure without losing later edits', { timeout: 45000 }, async t => {
  const server = await startServer(); t.after(() => server.close());
  const author = await account(server, 'autosave-controls@example.test');
  const project = await scene(server, author.cookie);
  const browser = await chromium.launch({ ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : {}), headless: true }); t.after(() => browser.close());
  const context = await browser.newContext();
  await context.addCookies([{ name: 'replica_session', value: author.cookie.split('=')[1], url: server.base }]);
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  let holdNext = true, failNext = false, release;
  await page.route(`**/api/my/projects/${project.id}`, async route => {
    if (route.request().method() !== 'PUT' || !holdNext) return route.continue();
    holdNext = false;
    await new Promise(resolve => { release = resolve; });
    if (failNext) return route.fulfill({ status: 503, json: { error: 'Проверка повторного сохранения' } });
    await route.continue();
  });
  t.after(() => release?.());
  await page.goto(server.base + '/workspace/segment/?project=' + project.id);
  await page.locator('[data-line-text]').first().fill('Первая правка');
  await page.waitForFunction(() => state.saving);
  // Changing a timestamp redraws the line list while the save is still pending.
  await page.locator('[data-line-time="end"]').last().fill('00:00:01.850');
  await page.locator('#project-role').fill('Новый персонаж');
  await page.locator('#project-text').fill('Следующая реплика');
  await page.locator('#project-start').fill('00:00:00.900');
  await page.locator('#project-end').fill('00:00:01.100');
  assert.equal(await page.locator('#project-add-line').isDisabled(), true);
  release();
  await page.waitForFunction(() => !state.saving && !document.querySelector('#project-add-line').disabled);
  assert.equal(await page.locator('#delete-my-project').isDisabled(), false);
  assert.equal(await page.locator('#project-text').inputValue(), 'Следующая реплика');
  assert.equal(await page.locator('[data-line-time="end"]').last().inputValue(), '00:00:01.850');
  await page.locator('#project-add-line').click();
  await page.waitForFunction(() => !state.saving && !state.dirty && state.segments.length === 3);
  let stored = (await server.api('/api/my/projects', { cookie: author.cookie })).data[0];
  assert.equal(stored.segments.length, 3);
  assert.equal(stored.segments[1].text, 'Следующая реплика');
  assert.equal(stored.segments[2].end, 1.85);

  holdNext = true; failNext = true;
  await page.locator('[data-line-text]').first().fill('Правка перед ошибкой');
  await page.waitForFunction(() => state.saving);
  await page.locator('[data-line-time="start"]').first().fill('00:00:00.150');
  await page.locator('#project-role').click();
  release();
  await page.waitForFunction(() => !state.saving && document.querySelector('#project-save-status').textContent.includes('Проверка повторного сохранения'));
  assert.equal(await page.locator('#project-add-line').isDisabled(), false);
  assert.equal(await page.locator('#delete-my-project').isDisabled(), false);
  assert.equal(await page.evaluate(() => state.dirty), true);
  await page.locator('#save-project').click();
  await page.waitForFunction(() => !state.saving && !state.dirty);
  stored = (await server.api('/api/my/projects', { cookie: author.cookie })).data[0];
  assert.equal(stored.segments[0].start, .15);
  assert.equal(stored.segments[0].text, 'Правка перед ошибкой');
  await page.reload(); await page.locator('.workspace-line').first().waitFor();
  assert.equal(await page.locator('.workspace-line').count(), 3);
  assert.equal(await page.locator('#project-add-line').isDisabled(), false);
  assert.deepEqual(errors, []);
});

test('locked scenes explain how to resume editing and link an administrator to the correct scene', { timeout: 45000 }, async t => {
  const server = await startServer(); t.after(() => server.close());
  const admin = await account(server, 'editor-admin@example.test', true);
  const project = await scene(server, admin.cookie);
  await server.api(`/api/admin/videos/${project.id}/publish`, { method: 'POST', cookie: admin.cookie });
  const other = await scene(server, admin.cookie);
  const member = await account(server, 'editor-member@example.test');
  const submitted = await scene(server, member.cookie);
  await server.api(`/api/my/projects/${submitted.id}/submit`, { method: 'POST', cookie: member.cookie });
  const browser = await chromium.launch({ ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : {}), headless: true }); t.after(() => browser.close());
  const context = await browser.newContext();
  await context.addCookies([{ name: 'replica_session', value: admin.cookie.split('=')[1], url: server.base }]);
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.base + '/workspace/segment/?project=' + project.id);
  await page.locator('.workspace-line').first().waitFor();
  assert.equal(await page.locator('#project-select').count(), 0);
  assert.match(await page.locator('#project-edit-reason').textContent(), /Сцена опубликована.*возврата на правки/);
  for (const selector of ['#project-role', '#project-text', '#project-start', '#project-end', '#project-add-line', '[data-project-capture="start"]']) {
    assert.equal(await page.locator(selector).isDisabled(), true);
  }
  await page.locator('#project-review-link').click();
  await page.waitForFunction(id => state.activeId === id && selected()?.status === 'published', project.id);
  assert.equal(await page.locator('#video-select').inputValue(), project.id);
  assert.equal(await page.locator('#segment-text').isDisabled(), true);
  assert.match(await page.locator('#admin-edit-notice').textContent(), /Вернуть на правки/);
  page.once('dialog', dialog => dialog.accept('Добавить пропущенную реплику'));
  await page.locator('#return-review').click();
  await page.waitForFunction(() => selected()?.status === 'rejected');
  assert.equal(await page.locator('#segment-text').isDisabled(), false);
  await page.goto(server.base + '/workspace/segment/?project=' + project.id);
  await page.locator('.workspace-line').first().waitFor();
  assert.equal(await page.locator('#project-edit-notice').isVisible(), false);
  await page.locator('#project-text').fill('Добавленная реплика');
  await page.locator('#project-start').fill('00:00:00.900');
  await page.locator('#project-end').fill('00:00:01.100');
  await page.locator('#project-add-line').click();
  await page.waitForFunction(() => !state.dirty && !state.saving && state.segments.length === 3);
  await page.locator(`.project-row[data-id="${other.id}"]`).click();
  await page.waitForFunction(id => state.activeId === id, other.id);
  assert.equal(await page.locator('.workspace-line').count(), 2);

  await context.clearCookies();
  await context.addCookies([{ name: 'replica_session', value: member.cookie.split('=')[1], url: server.base }]);
  await page.goto(server.base + '/workspace/segment/?project=' + submitted.id);
  await page.locator('.workspace-line').first().waitFor();
  assert.match(await page.locator('#project-edit-reason').textContent(), /Сцена на модерации.*администратором/);
  assert.equal(await page.locator('#project-text').isDisabled(), true);
  assert.equal(await page.locator('#project-review-link').isVisible(), false);
  await server.api(`/api/admin/videos/${submitted.id}/publish`, { method: 'POST', cookie: admin.cookie });
  await page.reload(); await page.locator('.workspace-line').first().waitFor();
  assert.match(await page.locator('#project-edit-reason').textContent(), /Сцена опубликована/);
  assert.equal(await page.locator('#project-text').isDisabled(), true);
  assert.equal(await page.locator('#project-review-link').isVisible(), false);
  assert.deepEqual(errors, []);
});

test('registration form does not truncate names or restrict email length', { timeout: 30000 }, async t => {
  const server = await startServer(); t.after(() => server.close());
  const browser = await chromium.launch({ ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : {}), headless: true }); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(server.base + '/register/');
  assert.equal(await page.locator('#name').getAttribute('maxlength'), null);
  assert.equal(await page.locator('#email').getAttribute('maxlength'), null);
  const name = 'Исполнитель ' + 'я'.repeat(70);
  const email = `${'a'.repeat(60)}@${'b'.repeat(60)}.${'c'.repeat(60)}.example`;
  await page.locator('#name').fill(name);
  await page.locator('#email').fill(email);
  await page.locator('#password').fill('password');
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(server.base + '/workspace/');
  assert.equal(await page.locator('#workspace-name').textContent(), name);
});

test('trimmed takes survive reload, preview and mix use the same edges, and reset restores the original', { timeout: 30000 }, async t => {
  const server = await startServer(); t.after(() => server.close());
  const author = await account(server, 'trim-browser@example.test'); const cookie = author.cookie;
  const source = await scene(server, cookie);
  let dub = (await server.api(`/api/my/projects/from/${source.id}`, { method: 'POST', cookie })).data;
  const bytes = wav(1);
  for (let sample = 0; sample < 48000; sample++) if (sample < .3 * 48000 || sample >= .6 * 48000) bytes.writeInt16LE(0, 44 + sample * 2);
  for (const [index, segment] of dub.segments.entries()) {
    dub = (await server.api(`/api/my/projects/${dub.id}/segments/${segment.id}/audio?fileName=take.wav`, { method: 'POST', cookie, body: index ? wav() : bytes })).data;
  }
  dub = (await server.api(`/api/my/projects/${dub.id}/mixdown`, { method: 'POST', cookie, body: wav(source.duration) })).data;
  const browser = await chromium.launch({ ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : {}), headless: true }); t.after(() => browser.close());
  const context = await browser.newContext(); await context.addCookies([{ name: 'replica_session', value: cookie.split('=')[1], url: server.base }]);
  const page = await context.newPage(); const errors = []; let dialogs = 0;
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => { dialogs++; dialog.accept(); });
  await page.goto(server.base + '/workspace/dub/?project=' + dub.id);
  await page.waitForFunction(() => state.project && state.waveformCache.size === 2);
  await page.click('#auto-trim');
  await page.waitForFunction(() => state.mode === null && state.segments[0].voiceTrimStart > .2);
  const trims = await page.evaluate(() => ({ start: state.segments[0].voiceTrimStart, end: state.segments[0].voiceTrimEnd }));
  assert.ok(Math.abs(trims.start - .22) < .002); assert.ok(Math.abs(trims.end - .32) < .002);
  assert.equal(await page.locator('#submit-dub').isVisible(), false);
  await page.reload(); await page.waitForFunction(() => state.project && state.waveformCache.size === 2);
  assert.equal(Number(await page.locator('#trim-start').inputValue()), trims.start);
  assert.equal(Number(await page.locator('#trim-end').inputValue()), trims.end);
  await page.click('#play-take');
  await page.waitForFunction(() => Boolean(state.takePlayback));
  assert.ok(Math.abs(await page.evaluate(() => state.takePlayback.duration) - (1 - trims.start - trims.end)) < .001);
  await page.waitForFunction(() => !state.takePlayback);
  assert.equal(await page.locator('#play-take').getAttribute('aria-label'), 'Прослушать дубль');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('#take-trim').scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/replica-trim-mobile.png' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('#take-trim').scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/replica-trim-desktop.png' });
  async function build() {
    await page.click('#next-line'); await page.click('#next-line'); await page.click('#build-mix');
    await page.waitForFunction(() => state.mode === null && Boolean(state.project.mixFile));
    const project = (await server.api('/api/my/projects', { cookie })).data.find(p => p.id === dub.id);
    const response = await fetch(server.base + project.mixUrl, { headers: { Cookie: cookie } });
    return Buffer.from(await response.arrayBuffer());
  }
  function speechBounds(wave) {
    assert.equal(wave.readUInt32LE(24), 48000);
    const active = [];
    for (let i = 0; i < 48000; i++) if (Math.abs(wave.readInt16LE(44 + i * 2)) > 100) active.push(i / 48000);
    return [active[0], active.at(-1)];
  }
  let mixed = await build();
  const bounds = speechBounds(mixed);
  assert.ok(Math.abs(bounds[0] - (.125 + .3 - trims.start)) < .002);
  assert.ok(Math.abs(bounds[1] - (.125 + .6 - trims.start)) < .002);
  assert.equal(dialogs, 0); // Trimmed duration fits, although the original does not.
  await page.locator('[data-track-index="0"]').click(); await page.waitForFunction(() => state.mode === null);
  await page.click('#reset-trim'); await page.waitForFunction(() => state.mode === null && !state.project.mixFile);
  assert.equal(await page.locator('#trim-start').inputValue(), '0');
  const original = await fetch(`${server.base}/api/my/projects/${dub.id}/segments/${dub.segments[0].id}/audio`, { headers: { Cookie: cookie } });
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes);
  mixed = await build(); const originalBounds = speechBounds(mixed);
  assert.ok(Math.abs(originalBounds[0] - .425) < .002); assert.ok(Math.abs(originalBounds[1] - .725) < .002);
  assert.equal(dialogs, 1);
  await page.locator('[data-track-index="0"]').click(); await page.waitForFunction(() => state.mode === null);
  await page.locator('#trim-start').fill('0.1'); await page.locator('#trim-end').fill('0.2');
  await page.click('#save-trim'); await page.waitForFunction(() => state.mode === null && state.segments[0].voiceTrimStart === .1);
  assert.equal(await page.locator('#trim-end').inputValue(), '0.2');
  await page.reload(); await page.waitForFunction(() => state.project !== null);
  assert.equal(await page.locator('#trim-start').inputValue(), '0.1'); assert.equal(await page.locator('#trim-end').inputValue(), '0.2');
  assert.deepEqual(errors, []);
});

async function waitForMicSample(page) {
  await page.evaluate(() => new Promise(resolve => {
    const recorder = micCheck.recorder;
    const received = event => { if (event.data.size) { recorder.removeEventListener('dataavailable', received); resolve(); } };
    recorder.addEventListener('dataavailable', received);
  }));
}

test('multiple takes can be compared, chosen and mixed; a lost upload response does not duplicate a recording', { timeout: 60000 }, async t => {
  const server = await startServer(); t.after(() => server.close());
  const author = await account(server, 'choose-take@example.test'), cookie = author.cookie;
  const source = await scene(server, cookie);
  let dub = (await server.api(`/api/my/projects/from/${source.id}`, { method: 'POST', cookie })).data;
  const base = `/api/my/projects/${dub.id}`, line = `${base}/segments/${dub.segments[0].id}`;
  dub = (await server.api(line + '/audio?fileName=first.wav&takeId=first', { method: 'POST', cookie, body: wav(.5) })).data;
  dub = (await server.api(base, { method: 'PUT', cookie, body: { revision: dub.revision, segments: dub.segments.map((s, i) => i ? s : { ...s, voiceTrimStart: .05, voiceTrimEnd: .05, voiceOffset: .02 }) } })).data;
  const quieter = wav(.3);
  for (let i = 44; i < quieter.length; i += 2) quieter.writeInt16LE(Math.round(quieter.readInt16LE(i) / 4), i);
  dub = (await server.api(line + '/audio?fileName=second.wav&takeId=second', { method: 'POST', cookie, body: quieter })).data;
  dub = (await server.api(`${base}/segments/${dub.segments[1].id}/audio?fileName=other.wav`, { method: 'POST', cookie, body: wav() })).data;
  dub = (await server.api(base + '/mixdown', { method: 'POST', cookie, body: wav(source.duration) })).data;
  const browser = await chromium.launch({ ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : {}), headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }); t.after(() => browser.close());
  const context = await browser.newContext({ permissions: ['microphone'] });
  await context.addCookies([{ name: 'replica_session', value: cookie.split('=')[1], url: server.base }]);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  await page.goto(server.base + '/workspace/dub/?project=' + dub.id);
  await page.waitForFunction(() => state.project && state.waveformCache.size === 2);
  assert.equal(await page.locator('.saved-take').count(), 2);
  assert.equal(await page.locator('[data-select-take="second"]').isDisabled(), true);
  await page.locator('[data-listen-take="first"]').click();
  await page.waitForFunction(() => state.takePlayback?.takeId === 'first');
  assert.ok(Math.abs(await page.evaluate(() => state.takePlayback.duration) - .4) < .001);
  assert.equal(await page.evaluate(() => state.segments[0].selectedTakeId), 'second');
  assert.equal(await page.evaluate(() => state.project.revision), dub.revision);
  assert.equal(await page.locator('#submit-dub').isVisible(), true);
  await page.locator('[data-select-take="first"]').click();
  await page.waitForFunction(() => state.mode === null && state.segments[0].selectedTakeId === 'first');
  assert.equal(await page.locator('#trim-start').inputValue(), '0.05'); assert.equal(await page.locator('#voice-offset').inputValue(), '0.02');
  assert.equal(await page.locator('#submit-dub').isVisible(), false);
  await page.reload(); await page.waitForFunction(() => state.project && state.waveformCache.size === 2);
  assert.equal(await page.locator('[data-select-take="first"]').isDisabled(), true);
  await page.setViewportSize({ width: 390, height: 844 }); await page.locator('#take-list').scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: '/tmp/replica-takes-mobile.png' });
  await page.setViewportSize({ width: 1280, height: 900 }); await page.locator('#take-list').scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/replica-takes-desktop.png' });
  await page.click('#next-line'); await page.click('#next-line');
  async function buildAndPeak() {
    await page.click('#build-mix'); await page.waitForFunction(() => state.mode === null && state.project.mixFile);
    const response = await fetch(server.base + base + '/mix', { headers: { Cookie: cookie } }), data = Buffer.from(await response.arrayBuffer());
    let peak = 0;
    for (let i = 0; i < 48000; i++) peak = Math.max(peak, Math.abs(data.readInt16LE(44 + i * 2)));
    return peak;
  }
  assert.ok(Math.abs(await buildAndPeak() - 3000) < 10);
  await page.locator('[data-track-index="0"]').click(); await page.waitForFunction(() => state.mode === null);
  await page.locator('[data-select-take="second"]').click(); await page.waitForFunction(() => state.mode === null && state.segments[0].selectedTakeId === 'second');
  assert.equal(await page.locator('#trim-start').inputValue(), '0'); assert.equal(await page.locator('#voice-offset').inputValue(), '0');
  assert.ok(Math.abs(await buildAndPeak() - 750) < 10);
  await page.route('**/segments/*/audio?*', async route => { await route.fetch(); await route.abort('failed'); });
  await page.click('#record-dub'); await page.waitForFunction(() => state.recorder?.state === 'recording');
  assert.equal(await page.locator('[data-select-take="first"]').isDisabled(), true);
  await page.evaluate(() => new Promise(resolve => state.recorder.addEventListener('dataavailable', resolve, { once: true })));
  await page.click('#record-dub'); await page.waitForFunction(() => state.mode === null && state.pendingTake);
  const serverProject = (await server.api('/api/my/projects', { cookie })).data.find(p => p.id === dub.id);
  assert.equal(serverProject.segments[0].takes.length, 3);
  await page.unroute('**/segments/*/audio?*'); await page.reload();
  await page.waitForFunction(() => Boolean(state.pendingTake));
  await page.click('#retry-take'); await page.waitForFunction(() => state.mode === null && !state.pendingTake);
  assert.equal(await page.locator('.saved-take').count(), 3);
  const recovered = (await server.api('/api/my/projects', { cookie })).data.find(p => p.id === dub.id);
  assert.equal(recovered.segments[0].takes.length, 3); assert.equal(recovered.revision, serverProject.revision);
  await page.locator('[data-select-take="first"]').click(); await page.waitForFunction(() => state.mode === null && state.segments[0].selectedTakeId === 'first');
  assert.equal(await page.locator('#trim-end').inputValue(), '0.05');
  assert.deepEqual(errors, []);
});

async function microphoneStudio(t) {
  const server = await startServer(); t.after(() => server.close());
  const author = await account(server, 'microphone@example.test'), cookie = author.cookie;
  const source = await scene(server, cookie);
  const dub = (await server.api(`/api/my/projects/from/${source.id}`, { method: 'POST', cookie })).data;
  const micFile = `${server.dir}/mic-check.wav`; await writeFile(micFile, wav(1));
  const browser = await chromium.launch({ ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : {}), headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${micFile}`] });
  t.after(() => browser.close());
  const context = await browser.newContext({ permissions: ['microphone'] });
  await context.addCookies([{ name: 'replica_session', value: cookie.split('=')[1], url: server.base }]);
  const page = await context.newPage(); const errors = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (['POST', 'PUT', 'DELETE'].includes(request.method())) writes.push(request.url()); });
  await page.addInitScript(() => {
    window.testStreams = [];
    window.realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async options => {
      const stream = await window.realGetUserMedia(options); window.testStreams.push(stream); return stream;
    };
  });
  await page.goto(server.base + '/workspace/dub/?project=' + dub.id);
  await page.waitForFunction(() => state.project && document.querySelector('#line-video').readyState >= 2);
  return { server, cookie, dub, page, errors, writes };
}

test('microphone check records a local sample, stops automatically and leaves dubbing available', { timeout: 45000 }, async t => {
  const { server, cookie, dub, page, errors, writes } = await microphoneStudio(t);
  await page.click('#check-microphone');
  await page.waitForFunction(() => micCheck.phase === 'recording' && micCheck.signalFrames >= 3);
  assert.equal(await page.locator('#record-dub').isDisabled(), true);
  assert.ok(await page.locator('#mic-check-meter').evaluate(node => Number(node.getAttribute('aria-valuenow')) > -60));
  await page.evaluate(() => { window.testCaptureContext = micCheck.context; });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('#mic-check-dialog').evaluate(node => node.scrollWidth <= node.clientWidth), true);
  await page.screenshot({ path: '/tmp/replica-mic-check-mobile.png' });
  await page.waitForFunction(() => micCheck.phase === 'ready');
  assert.equal(await page.evaluate(() => performance.now() - micCheck.startedAt < 6500), true);
  assert.equal(await page.evaluate(() => window.testStreams.every(s => s.getTracks().every(t => t.readyState === 'ended'))), true);
  assert.equal(await page.evaluate(() => window.testCaptureContext.state), 'closed');
  assert.match(await page.locator('#mic-check-signal').textContent(), /Сигнал есть/);
  await page.locator('#mic-check-player').evaluate(player => player.play());
  await page.waitForFunction(() => document.querySelector('#mic-check-player').currentTime > .1);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: '/tmp/replica-mic-check-desktop.png' });
  await page.click('#mic-check-action');
  await page.waitForFunction(() => micCheck.phase === 'recording' && micCheck.signalFrames >= 3);
  await waitForMicSample(page);
  await page.click('#mic-check-action'); await page.waitForFunction(() => micCheck.phase === 'ready');
  assert.equal(await page.evaluate(() => window.testStreams.every(s => s.getTracks().every(t => t.readyState === 'ended'))), true);
  assert.deepEqual(writes, []);
  const stored = (await server.api('/api/my/projects', { cookie })).data.find(p => p.id === dub.id);
  assert.deepEqual(stored.segments, dub.segments); assert.equal(stored.revision, dub.revision);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#mic-check-dialog').isVisible(), false);
  assert.equal(await page.evaluate(() => micCheck.sampleUrl), null);
  assert.equal(await page.locator('#mic-check-player').getAttribute('src'), null);
  await page.click('#record-dub'); await page.waitForFunction(() => state.recorder?.state === 'recording');
  assert.equal(await page.locator('#check-microphone').isDisabled(), true);
  await page.waitForTimeout(200); await page.click('#record-dub');
  await page.waitForFunction(() => !state.pendingTake && state.mode === null && state.segments[0].voiceFile);
  assert.equal(await page.locator('#check-microphone').isDisabled(), false);
  assert.deepEqual(errors, []);
});

test('microphone check handles access errors and stops a late permission grant after closing', { timeout: 30000 }, async t => {
  const { page, errors, writes } = await microphoneStudio(t);
  for (const [name, message] of [['NotAllowedError', /Доступ к микрофону запрещён/], ['NotFoundError', /Микрофон не найден/], ['NotReadableError', /Микрофон недоступен/]]) {
    await page.evaluate(name => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Test error', name); }; }, name);
    if (await page.locator('#mic-check-dialog').isVisible()) await page.click('#mic-check-action'); else await page.click('#check-microphone');
    await page.waitForFunction(() => micCheck.phase === 'error');
    assert.match(await page.locator('#mic-check-status').textContent(), message);
    assert.equal(await page.locator('#mic-check-action').isEnabled(), true);
    assert.equal(await page.evaluate(() => micCheck.context === null && micCheck.stream === null), true);
  }
  await page.click('#mic-check-close');
  await page.evaluate(() => {
    let calls = 0;
    navigator.mediaDevices.getUserMedia = async options => {
      if (++calls === 1) await new Promise(resolve => { window.grantLatePermission = resolve; });
      const stream = await window.realGetUserMedia(options); window.testStreams.push(stream); return stream;
    };
  });
  await page.click('#check-microphone'); await page.waitForFunction(() => Boolean(window.grantLatePermission));
  await page.click('#mic-check-close');
  await page.click('#check-microphone'); await page.waitForFunction(() => micCheck.phase === 'recording');
  await page.evaluate(() => window.grantLatePermission());
  await page.waitForFunction(() => window.testStreams.length === 2 && window.testStreams[1].getTracks().every(t => t.readyState === 'ended'));
  assert.equal(await page.evaluate(() => window.testStreams[0].getTracks().every(t => t.readyState === 'live')), true);
  assert.equal(await page.locator('#mic-check-dialog').isVisible(), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => window.testStreams.every(s => s.getTracks().every(t => t.readyState === 'ended'))), true);
  assert.equal(await page.locator('#record-dub').isEnabled(), true);
  assert.deepEqual(errors, []); assert.deepEqual(writes, []);
});

test('microphone check distinguishes silence and clipping and releases capture on page exit', { timeout: 30000 }, async t => {
  const { page, errors, writes } = await microphoneStudio(t);
  await page.evaluate(() => {
    window.testSignalLevel = 0; window.testGenerators = [];
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext(); await context.resume();
      const source = context.createConstantSource(), target = context.createMediaStreamDestination();
      source.offset.value = window.testSignalLevel; source.connect(target); source.start();
      window.testGenerators.push({ context, source }); window.testStreams.push(target.stream); return target.stream;
    };
  });
  await page.click('#check-microphone'); await page.waitForFunction(() => micCheck.phase === 'recording');
  await waitForMicSample(page);
  await page.click('#mic-check-action'); await page.waitForFunction(() => micCheck.phase === 'ready');
  assert.match(await page.locator('#mic-check-signal').textContent(), /очень тихий или отсутствует/);
  await page.evaluate(() => { window.testSignalLevel = 1; });
  await page.click('#mic-check-action'); await page.waitForFunction(() => micCheck.clippedFrames >= 3);
  await waitForMicSample(page);
  await page.click('#mic-check-action'); await page.waitForFunction(() => micCheck.phase === 'ready');
  assert.match(await page.locator('#mic-check-signal').textContent(), /перегружен/);
  await page.click('#mic-check-action'); await page.waitForFunction(() => micCheck.phase === 'recording');
  await page.evaluate(() => micCheck.stream.getAudioTracks()[0].dispatchEvent(new Event('ended')));
  await page.waitForFunction(() => micCheck.phase === 'error');
  assert.match(await page.locator('#mic-check-status').textContent(), /Микрофон отключился/);
  assert.equal(await page.evaluate(() => window.testStreams.every(s => s.getTracks().every(t => t.readyState === 'ended'))), true);
  await page.click('#mic-check-action'); await page.waitForFunction(() => micCheck.phase === 'recording');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  assert.equal(await page.evaluate(() => window.testStreams.every(s => s.getTracks().every(t => t.readyState === 'ended'))), true);
  assert.equal(await page.evaluate(() => !micCheck.opened && micCheck.context === null && micCheck.sampleUrl === null), true);
  await page.evaluate(async () => { for (const generator of window.testGenerators) { generator.source.stop(); await generator.context.close(); } });
  assert.deepEqual(errors, []); assert.deepEqual(writes, []);
});

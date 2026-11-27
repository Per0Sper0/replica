import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { readFile, readdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore } from '../lib/store.mjs';
import { startServer, createTestDatabase, root, account, scene, wav, video } from './helpers.mjs';

test('concurrent registration, explicit admin and persistent expiring sessions', async t => {
  const server = await startServer(); t.after(() => server.close());
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => account(server, `user${i}@example.test`)));
  assert.ok(results.every(r => r.data.user.role === 'member'));
  for (let i = 0; i < 6; i++) assert.equal((await server.api('/api/auth/login', { method: 'POST', body: { email: `user${i}@example.test`, password: 'test-password' } })).status, 200);
  const duplicates = await Promise.all([1, 2].map(() => server.api('/api/auth/register', { method: 'POST', body: { name: 'Same User', email: 'same@example.test', password: 'test-password' } })));
  assert.deepEqual(duplicates.map(r => r.status).sort(), [201, 409]);
  server.promote('user0@example.test'); const cookie = results[0].cookie;
  await server.restart();
  assert.equal((await server.api('/api/auth/me', { cookie })).data.user.role, 'admin');
  const store = await openStore(server.databaseUrl); await store.query('UPDATE sessions SET expires=0'); await store.close();
  assert.equal((await server.api('/api/auth/me', { cookie })).data.user, null);
});

test('valid media, concurrency isolation, revision conflicts and rejected uploads cleanup', async t => {
  const server = await startServer(); t.after(() => server.close()); const user = await account(server, 'author@example.test'); const cookie = user.cookie;
  const source = await scene(server, cookie);
  assert.ok(source.duration > 1.8); assert.equal(source.segments[0].start, .125);
  const clone = await server.api(`/api/my/projects/from/${source.id}`, { method: 'POST', cookie }); const dub = clone.data;
  const target = `/api/my/projects/${dub.id}/segments/${dub.segments[0].id}/audio?fileName=take.wav`;
  const before = await readdir(path.join(server.dir, 'uploads'));
  const invalid = await server.api(target, { method: 'POST', cookie, body: '<html><script>bad()</script></html>', headers: { 'Content-Type': 'text/html' } });
  assert.equal(invalid.status, 415); assert.deepEqual(await readdir(path.join(server.dir, 'uploads')), before);
  const bytes = wav(); let finish;
  const completed = new Promise((resolve, reject) => {
    const request = http.request(server.base + target, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'audio/wav' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); request.on('error', reject); request.write(bytes.subarray(0, 44)); finish = () => request.end(bytes.subarray(44));
  });
  await new Promise(resolve => setTimeout(resolve, 100));
  const changed = await server.api(`/api/my/projects/${source.id}`, { method: 'PUT', cookie, body: { revision: source.revision, segments: [{ ...source.segments[0], text: 'Updated while uploading' }] } }); assert.equal(changed.status, 200);
  finish(); assert.equal(await completed, 201);
  const projects = (await server.api('/api/my/projects', { cookie })).data;
  assert.equal(projects.find(p => p.id === source.id).segments[0].text, 'Updated while uploading');
  assert.equal((await server.api(`/api/my/projects/${source.id}`, { method: 'PUT', cookie, body: { revision: source.revision, segments: source.segments } })).status, 409);
  const current = projects.find(p => p.id === dub.id);
  const uploaded = await server.api(target, { method: 'POST', cookie, body: wav(), headers: { 'Content-Type': 'text/html', 'X-Project-Version': String(current.revision) } }); assert.equal(uploaded.status, 201);
  const served = await server.api(target.split('?')[0], { cookie });
  assert.equal(served.headers.get('content-type'), 'audio/wav'); assert.equal(served.headers.get('x-content-type-options'), 'nosniff'); assert.ok(served.headers.get('content-security-policy').includes('sandbox'));
  const conflict = await server.api(target, { method: 'POST', cookie, body: wav(), headers: { 'X-Project-Version': String(current.revision) } }); assert.equal(conflict.status, 409);
  const invalidTiming = await server.api(`/api/my/projects/${source.id}`, { method: 'PUT', cookie, body: { revision: changed.data.revision, segments: [{ id: 'bad', start: 0, end: 900, text: 'Outside video' }] } }); assert.equal(invalidTiming.status, 422);
  const stranger = await account(server, 'stranger@example.test'); assert.equal((await server.api(`/api/my/projects/${source.id}/file`, { cookie: stranger.cookie })).status, 404);
});

test('scene → dub → mix → review → public versions and rework', async t => {
  const server = await startServer(); t.after(() => server.close()); const admin = await account(server, 'admin@example.test', true); const author = await account(server, 'author@example.test'); const cookie = author.cookie;
  let source = await scene(server, cookie);
  assert.equal((await server.api(`/api/my/projects/${source.id}/submit`, { method: 'POST', cookie })).status, 200);
  source = (await server.api(`/api/admin/videos/${source.id}/publish`, { method: 'POST', cookie: admin.cookie })).data;
  let dub = (await server.api(`/api/my/projects/from/${source.id}`, { method: 'POST', cookie })).data;
  assert.equal((await server.api(`/api/admin/videos/${dub.id}/publish`, { method: 'POST', cookie: admin.cookie })).status, 422);
  for (const segment of dub.segments) {
    const result = await server.api(`/api/my/projects/${dub.id}/segments/${segment.id}/audio?fileName=take.wav`, { method: 'POST', cookie, body: wav(), headers: { 'X-Project-Version': String(dub.revision) } }); assert.equal(result.status, 201); dub = result.data;
  }
  dub = (await server.api(`/api/my/projects/${dub.id}/mixdown`, { method: 'POST', cookie, body: wav(source.duration) })).data;
  assert.ok(dub.mixFile);
  assert.equal((await server.api(`/api/my/projects/${dub.id}/submit`, { method: 'POST', cookie })).status, 200);
  assert.equal((await server.api(`/api/admin/videos/${dub.id}/publish`, { method: 'POST', cookie: admin.cookie })).status, 200);
  const catalog = (await server.api('/api/videos')).data;
  assert.equal(catalog.length, 1); assert.equal(catalog[0].projectType, 'scene'); assert.equal(catalog[0].dubs.length, 1); assert.equal(catalog[0].dubs[0].id, dub.id);
  assert.equal((await server.api(catalog[0].dubs[0].mixUrl)).status, 200);
  const range = await server.api(catalog[0].dubs[0].mixUrl, { headers: { Range: 'bytes=-10' } }); assert.equal(range.status, 206); assert.equal(range.headers.get('content-length'), '10');
  assert.equal((await server.api(`/api/admin/videos/${dub.id}/reject`, { method: 'POST', cookie: admin.cookie })).status, 422);
  dub = (await server.api(`/api/admin/videos/${dub.id}/reject`, { method: 'POST', cookie: admin.cookie, body: { comment: 'Поправьте интонацию' } })).data;
  assert.equal(dub.reviewComment, 'Поправьте интонацию'); assert.equal(dub.reviewHistory.length, 2);
  assert.equal((await server.api(`/api/videos/${dub.id}/mix`)).status, 404);
  dub = (await server.api(`/api/my/projects/${dub.id}`, { method: 'PUT', cookie, body: { revision: dub.revision, segments: dub.segments } })).data;
  assert.equal(dub.mixFile, undefined);
  assert.equal((await server.api(`/api/my/projects/${dub.id}/submit`, { method: 'POST', cookie })).status, 422);
  assert.equal((await server.api(`/api/admin/videos/${dub.id}/publish`, { method: 'POST', cookie: admin.cookie })).status, 422);
});

test('legacy JSON imports once and keeps source files intact', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'replica-migration-'));
  const users = JSON.stringify([{ id: 'legacy', email: 'legacy@example.test', name: 'Legacy', role: 'admin' }]);
  await writeFile(path.join(dir, 'users.json'), users); await writeFile(path.join(dir, 'catalog.json'), JSON.stringify([{ id: 'scene', status: 'draft', segments: [] }]));
  const server = await startServer(dir); t.after(() => server.close());
  const migrated = server.migrate(); assert.equal(migrated.status, 0, migrated.stderr);
  const store = await openStore(server.databaseUrl); assert.equal((await store.user('legacy')).role, 'admin'); assert.equal((await store.getProject('scene')).revision, 1); await store.close();
  assert.equal(server.migrate().status, 0);
  await server.restart(); assert.equal(await readFile(path.join(dir, 'users.json'), 'utf8'), users);
});

test('PostgreSQL row locks reject competing edits and transactions roll back', async t => {
  const server = await startServer(); let store; t.after(async () => { await store?.close(); await server.close(); });
  const author = await account(server, 'race@example.test'); const project = await scene(server, author.cookie);
  const updates = await Promise.all(['First edit', 'Second edit'].map(text => server.api(`/api/my/projects/${project.id}`, { method: 'PUT', cookie: author.cookie, body: { revision: project.revision, segments: [{ ...project.segments[0], text }] } })));
  assert.deepEqual(updates.map(response => response.status).sort(), [200, 409]);
  store = await openStore(server.databaseUrl);
  await assert.rejects(store.transaction(async tx => {
    await tx.putProject({ id: 'rolled-back', revision: 1, segments: [] });
    throw new Error('Rollback check');
  }), /Rollback check/);
  assert.equal(await store.getProject('rolled-back'), null);
  const clones = await Promise.all([1, 2].map(() => server.api(`/api/my/projects/from/${project.id}`, { method: 'POST', cookie: author.cookie })));
  assert.ok(clones.every(response => response.status === 201));
  assert.equal(clones[0].data.id, clones[1].data.id);
});

test('SQLite importer preserves projects, account roles and active sessions', async t => {
  const { DatabaseSync } = await import('node:sqlite');
  const { createHash } = await import('node:crypto');
  const dir = await mkdtemp(path.join(tmpdir(), 'replica-sqlite-import-'));
  const file = path.join(dir, 'replica.sqlite');
  const legacy = new DatabaseSync(file);
  legacy.exec('CREATE TABLE users (data TEXT); CREATE TABLE projects (data TEXT); CREATE TABLE sessions (token TEXT,user_id TEXT,expires INTEGER)');
  legacy.prepare('INSERT INTO users VALUES (?)').run(JSON.stringify({ id: 'legacy-user', name: 'Legacy', email: 'legacy@example.test', role: 'admin' }));
  legacy.prepare('INSERT INTO projects VALUES (?)').run(JSON.stringify({ id: 'legacy-project', revision: 7, status: 'draft', ownerId: 'legacy-user', segments: [{ id: 'line', text: 'Preserved' }] }));
  legacy.prepare('INSERT INTO sessions VALUES (?,?,?)').run(createHash('sha256').update('legacy-token').digest('hex'), 'legacy-user', Date.now() + 3600000);
  legacy.close(); const original = await readFile(file);
  const server = await startServer(dir); t.after(() => server.close());
  const result = server.migrate(); assert.equal(result.status, 0, result.stderr);
  assert.equal((await server.api('/api/auth/me', { cookie: 'replica_session=legacy-token' })).data.user.role, 'admin');
  const project = (await server.api('/api/my/projects', { cookie: 'replica_session=legacy-token' })).data[0]; assert.equal(project.revision, 7); assert.equal(project.segments[0].text, 'Preserved');
  assert.deepEqual(await readFile(file), original);
  assert.equal(server.migrate().status, 0);
  assert.equal((await server.api('/api/my/projects', { cookie: 'replica_session=legacy-token' })).data.length, 1);
});

test('legacy import rolls back on invalid data and refuses a populated target', async t => {
  const server = await startServer(); let store; t.after(async () => { await store?.close(); await server.close(); });
  await writeFile(path.join(server.dir, 'users.json'), JSON.stringify([{ id: 'a', email: 'same@example.test' }, { id: 'b', email: 'same@example.test' }]));
  await writeFile(path.join(server.dir, 'catalog.json'), '[]');
  assert.notEqual(server.migrate().status, 0);
  store = await openStore(server.databaseUrl);
  assert.equal((await store.users()).length, 0);
  await account(server, 'existing@example.test');
  await writeFile(path.join(server.dir, 'users.json'), JSON.stringify([{ id: 'legacy', email: 'legacy@example.test' }]));
  const result = server.migrate(); assert.notEqual(result.status, 0); assert.match(result.stderr, /пустую базу/);
  assert.equal((await store.users()).length, 1);
});

test('PostgreSQL backup restores accounts, projects and associated media', { skip: !process.env.PG_DOCKER_SERVICE }, async t => {
  const server = await startServer(); t.after(() => server.close());
  const backupRoot = await mkdtemp(path.join(tmpdir(), 'replica-pg-backup-')); t.after(() => rm(backupRoot, { recursive: true, force: true }));
  const backup = path.join(backupRoot, 'snapshot');
  const author = await account(server, 'backup@example.test'); const project = await scene(server, author.cookie);
  let dub = (await server.api(`/api/my/projects/from/${project.id}`, { method: 'POST', cookie: author.cookie })).data;
  for (const duration of [.2, .3]) dub = (await server.api(`/api/my/projects/${dub.id}/segments/${dub.segments[0].id}/audio?fileName=take.wav`, { method: 'POST', cookie: author.cookie, body: wav(duration) })).data;
  const result = spawnSync(process.execPath, ['scripts/backup.mjs', backup], { cwd: root, env: { ...process.env, DATA_DIR: server.dir, DATABASE_URL: server.databaseUrl }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.ok(await readFile(path.join(backup, 'COMPLETE'), 'utf8'));
  assert.deepEqual(await readFile(path.join(backup, 'uploads', project.diskName)), await readFile(path.join(server.dir, 'uploads', project.diskName)));
  for (const take of dub.segments[0].takes) assert.deepEqual(await readFile(path.join(backup, 'uploads', take.voiceFile)), await readFile(path.join(server.dir, 'uploads', take.voiceFile)));
  const target = await createTestDatabase(); let restored; t.after(async () => { await restored?.close(); await target.close(); });
  const url = new URL(target.databaseUrl);
  const restore = spawnSync('docker', ['compose', 'exec', '-T', '-e', 'PGDATABASE', '-e', 'PGUSER', '-e', 'PGPASSWORD', process.env.PG_DOCKER_SERVICE, 'pg_restore', '--exit-on-error', '--no-owner', '--no-privileges', '--dbname', decodeURIComponent(url.pathname.slice(1))], { cwd: root, env: { ...process.env, PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password) }, input: await readFile(path.join(backup, 'replica.dump')) });
  assert.equal(restore.status, 0, restore.stderr.toString());
  restored = await openStore(target.databaseUrl);
  assert.equal((await restored.userByEmail('backup@example.test')).id, author.data.user.id);
  const { videoUrl, mixUrl, ...storedProject } = project;
  assert.deepEqual(await restored.getProject(project.id), storedProject);
  const restoredDub = await restored.getProject(dub.id);
  assert.deepEqual(restoredDub.segments[0].takes, dub.segments[0].takes);
  assert.equal(restoredDub.segments[0].selectedTakeId, dub.segments[0].selectedTakeId);
});

test('registration accepts short and long names and emails beyond the former limit', async t => {
  const server = await startServer(); t.after(() => server.close());
  const longName = 'Имя ' + 'а'.repeat(80);
  const longEmail = `${'a'.repeat(60)}@${'b'.repeat(60)}.${'c'.repeat(60)}.example`;
  for (const [name, email] of [['Я', 'short@example.test'], [longName, longEmail]]) {
    const result = await server.api('/api/auth/register', { method: 'POST', body: { name, email, password: 'password' } });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    assert.equal(result.data.user.name, name);
    assert.equal(result.data.user.email, email);
  }
  for (const [body, error] of [
    [{ name: '   ', email: 'blank@example.test', password: 'password' }, 'Укажите имя или псевдоним'],
    [{ name: 'Я', email: 'not-an-email', password: 'password' }, 'Укажите корректный email, например name@example.com'],
    [{ name: 'Я', email: 'password@example.test', password: '1234567' }, 'Пароль должен содержать не менее 8 символов'],
  ]) {
    const result = await server.api('/api/auth/register', { method: 'POST', body });
    assert.equal(result.status, 400);
    assert.equal(result.data.error, error);
  }
});

test('take trimming persists, validates source bounds, invalidates mix and preserves original audio', async t => {
  const server = await startServer(); t.after(() => server.close());
  const author = await account(server, 'trim@example.test'); const cookie = author.cookie;
  const source = await scene(server, cookie);
  let dub = (await server.api(`/api/my/projects/from/${source.id}`, { method: 'POST', cookie })).data;
  const path = `/api/my/projects/${dub.id}`;
  const bytes = wav(1);
  const audioPath = `${path}/segments/${dub.segments[0].id}/audio`;
  for (const segment of dub.segments) {
    dub = (await server.api(`${path}/segments/${segment.id}/audio?fileName=take.wav`, { method: 'POST', cookie, body: bytes })).data;
  }
  dub = (await server.api(`${path}/mixdown`, { method: 'POST', cookie, body: wav(source.duration) })).data;
  assert.ok(dub.mixFile);
  const originalFile = dub.segments[0].voiceFile, previousRevision = dub.revision;
  const edit = (segments, revision = dub.revision) => server.api(path, { method: 'PUT', cookie, body: { revision, segments } });
  let result = await edit(dub.segments.map((s, i) => i ? s : { ...s, voiceTrimStart: .2, voiceTrimEnd: .3 }));
  assert.equal(result.status, 200); dub = result.data;
  assert.equal(dub.segments[0].voiceFile, originalFile); assert.equal(dub.mixFile, undefined);
  assert.equal((await server.api(`${path}/submit`, { method: 'POST', cookie })).status, 422);
  assert.equal((await edit(dub.segments, previousRevision)).status, 409);
  for (const bounds of [
    { voiceTrimStart: -1, voiceTrimEnd: 0 }, { voiceTrimStart: .5, voiceTrimEnd: .5 },
    { voiceTrimStart: 1.1, voiceTrimEnd: 0 }, { voiceTrimStart: 'NaN', voiceTrimEnd: 0 },
    { voiceTrimStart: 0, voiceTrimEnd: -1 },
  ]) assert.equal((await edit(dub.segments.map((s, i) => i ? s : { ...s, ...bounds }))).status, 422);
  assert.equal((await edit([...dub.segments, { id: 'no-recording', start: 0, end: .5, text: 'No take', voiceTrimStart: .1 }])).status, 422);
  // Existing editors that do not send the new fields must retain the trim.
  result = await edit(dub.segments.map(({ voiceTrimStart, voiceTrimEnd, ...s }) => s));
  assert.equal(result.status, 200); dub = result.data;
  await server.restart();
  dub = (await server.api('/api/my/projects', { cookie })).data.find(p => p.id === dub.id);
  assert.equal(dub.segments[0].voiceTrimStart, .2); assert.equal(dub.segments[0].voiceTrimEnd, .3);
  const original = await fetch(server.base + audioPath, { headers: { Cookie: cookie } });
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes);
  dub = (await edit(dub.segments.map(s => ({ ...s, voiceTrimStart: 0, voiceTrimEnd: 0 })))).data;
  assert.equal(dub.segments[0].voiceFile, originalFile);
  dub = (await edit(dub.segments.map(s => ({ ...s, voiceTrimStart: .2, voiceTrimEnd: .3 })))).data;
  result = await server.api(audioPath + '?fileName=new.wav', { method: 'POST', cookie, body: wav(.1) });
  assert.equal(result.status, 201);
  assert.equal(result.data.segments[0].voiceTrimStart, 0); assert.equal(result.data.segments[0].voiceTrimEnd, 0);
  assert.notEqual(result.data.segments[0].voiceFile, originalFile);
});

test('multiple takes retain files and edits, survive retries, protect access and require rebuilding after selection', async t => {
  const server = await startServer(); t.after(() => server.close());
  const author = await account(server, 'takes@example.test'), admin = await account(server, 'moderator@example.test', true), stranger = await account(server, 'other@example.test');
  const cookie = author.cookie, source = await scene(server, cookie);
  let dub = (await server.api(`/api/my/projects/from/${source.id}`, { method: 'POST', cookie })).data;
  const base = `/api/my/projects/${dub.id}`, line = `${base}/segments/${dub.segments[0].id}`;
  const upload = (id, bytes, revision = dub.revision) => server.api(`${line}/audio?fileName=take.wav&takeId=${id}`, { method: 'POST', cookie, body: bytes, headers: { 'X-Project-Version': String(revision) } });
  const choose = (id, revision = dub.revision) => server.api(`${line}/takes/${id}/select`, { method: 'POST', cookie, headers: { 'X-Project-Version': String(revision) } });
  dub = (await upload('first', wav(.5))).data;
  dub = (await server.api(base, { method: 'PUT', cookie, body: { revision: dub.revision, segments: dub.segments.map((s, i) => i ? s : { ...s, voiceTrimStart: .05, voiceTrimEnd: .1, voiceOffset: .03 }) } })).data;
  const first = dub.segments[0].takes[0], uploadRevision = dub.revision;
  dub = (await upload('second', wav(.3))).data;
  assert.equal(dub.segments[0].takes.length, 2); assert.equal(dub.segments[0].selectedTakeId, 'second');
  assert.equal(dub.segments[0].voiceOffset, 0); assert.equal(dub.segments[0].voiceTrimStart, 0);
  assert.deepEqual(dub.segments[0].takes[0], first);
  const filesBeforeRetry = (await readdir(path.join(server.dir, 'uploads'))).sort();
  const retry = await upload('second', wav(.3), uploadRevision);
  assert.equal(retry.status, 201); assert.equal(retry.data.revision, dub.revision); assert.equal(retry.data.segments[0].takes.length, 2);
  assert.deepEqual((await readdir(path.join(server.dir, 'uploads'))).sort(), filesBeforeRetry);
  const firstAudio = await fetch(server.base + line + '/takes/first/audio', { headers: { Cookie: cookie } });
  assert.deepEqual(Buffer.from(await firstAudio.arrayBuffer()), wav(.5));
  assert.equal((await server.api(line + '/takes/first/audio', { cookie: stranger.cookie })).status, 404);
  assert.equal((await server.api(line + '/takes/first/audio')).status, 401);
  assert.equal((await server.api(line + '/takes/first/select', { method: 'POST', cookie: stranger.cookie })).status, 404);
  assert.equal((await choose('missing')).status, 404);
  dub = (await choose('first')).data;
  assert.equal(dub.segments[0].voiceFile, first.voiceFile);
  assert.equal(dub.segments[0].voiceTrimStart, .05); assert.equal(dub.segments[0].voiceTrimEnd, .1); assert.equal(dub.segments[0].voiceOffset, .03);
  await server.restart(); dub = (await server.api('/api/my/projects', { cookie })).data.find(p => p.id === dub.id);
  assert.equal(dub.segments[0].selectedTakeId, 'first'); assert.equal(dub.segments[0].takes.length, 2);
  dub = (await server.api(`${base}/segments/${dub.segments[1].id}/audio?fileName=other.wav`, { method: 'POST', cookie, body: wav() })).data;
  dub = (await server.api(`${base}/mixdown`, { method: 'POST', cookie, body: wav(source.duration) })).data;
  const mixedRevision = dub.revision;
  assert.equal((await server.api(line + '/takes/second/audio', { cookie })).status, 200);
  assert.equal((await server.api('/api/my/projects', { cookie })).data.find(p => p.id === dub.id).revision, mixedRevision);
  dub = (await choose('second')).data;
  assert.equal(dub.mixFile, undefined); assert.equal((await choose('first', mixedRevision)).status, 409);
  assert.equal((await server.api(`${base}/submit`, { method: 'POST', cookie })).status, 422);
  // General segment edits cannot forge files, history or the selected take.
  dub = (await server.api(base, { method: 'PUT', cookie, body: { revision: dub.revision, segments: dub.segments.map(s => ({ ...s, voiceFile: 'forged.wav', selectedTakeId: 'forged', takes: [{ id: 'forged', voiceFile: 'forged.wav' }] })) } })).data;
  assert.equal(dub.segments[0].selectedTakeId, 'second'); assert.equal(dub.segments[0].takes.length, 2);
  assert.notEqual(dub.segments[0].voiceFile, 'forged.wav');
  dub = (await server.api(`${base}/mixdown`, { method: 'POST', cookie, body: wav(source.duration) })).data;
  await server.api(`/api/my/projects/${source.id}/submit`, { method: 'POST', cookie });
  await server.api(`/api/admin/videos/${source.id}/publish`, { method: 'POST', cookie: admin.cookie });
  dub = (await server.api(`${base}/submit`, { method: 'POST', cookie })).data;
  assert.equal((await choose('first')).status, 409);
  await server.api(`/api/admin/videos/${dub.id}/publish`, { method: 'POST', cookie: admin.cookie });
  const catalog = (await server.api('/api/videos')).data;
  assert.ok(catalog[0].dubs[0].segments.every(s => !('takes' in s)));
  assert.equal((await server.api(`/api/videos/${dub.id}/segments/${dub.segments[0].id}/takes/first/audio`)).status, 404);
  const publicAudio = await fetch(`${server.base}/api/videos/${dub.id}/segments/${dub.segments[0].id}/audio`);
  assert.deepEqual(Buffer.from(await publicAudio.arrayBuffer()), wav(.3));
  assert.equal((await server.api(`/api/admin/videos/${dub.id}`, { method: 'DELETE', cookie: admin.cookie })).status, 200);
  const remaining = await readdir(path.join(server.dir, 'uploads'));
  for (const segment of dub.segments) for (const take of segment.takes) assert.ok(!remaining.includes(take.voiceFile));
  assert.ok(remaining.includes(source.diskName));
});

test('legacy single recordings become stable first takes and concurrent duplicate uploads do not add copies', async t => {
  const server = await startServer(); t.after(() => server.close());
  const author = await account(server, 'legacy-take@example.test'), cookie = author.cookie;
  const source = await scene(server, cookie);
  let dub = (await server.api(`/api/my/projects/from/${source.id}`, { method: 'POST', cookie })).data;
  const base = `/api/my/projects/${dub.id}`, line = `${base}/segments/${dub.segments[0].id}`;
  dub = (await server.api(line + '/audio?fileName=old.wav', { method: 'POST', cookie, body: wav() })).data;
  const originalFile = dub.segments[0].voiceFile;
  const store = await openStore(server.databaseUrl);
  try { delete dub.segments[0].takes; delete dub.segments[0].selectedTakeId; await store.putProject(dub); } finally { await store.close(); }
  const read = async () => (await server.api('/api/my/projects', { cookie })).data.find(p => p.id === dub.id);
  let current = await read(); const legacyId = current.segments[0].takes[0].id;
  assert.equal((await read()).segments[0].takes[0].id, legacyId); assert.equal(current.revision, dub.revision);
  const results = await Promise.all([1, 2].map(() => server.api(line + '/audio?fileName=new.wav&takeId=same-recording', { method: 'POST', cookie, body: wav(.2), headers: { 'X-Project-Version': String(dub.revision) } })));
  assert.ok(results.every(r => r.status === 201)); current = await read();
  assert.equal(current.segments[0].takes.length, 2); assert.equal(current.segments[0].takes[0].voiceFile, originalFile);
  assert.equal(current.revision, dub.revision + 1);
  assert.equal((await readdir(path.join(server.dir, 'uploads'))).length, 3); // Video + two takes.
  const chosen = await server.api(`${line}/takes/${legacyId}/select`, { method: 'POST', cookie, headers: { 'X-Project-Version': String(current.revision) } });
  assert.equal(chosen.status, 200); assert.equal(chosen.data.segments[0].voiceFile, originalFile);
});

test('storage quota counts every take rather than only the selected recording', async t => {
  const bytes = wav(.2), limit = video.length + bytes.length * 2;
  const server = await startServer(undefined, { MAX_USER_STORAGE_BYTES: String(limit) }); t.after(() => server.close());
  const author = await account(server, 'quota-takes@example.test'), cookie = author.cookie;
  const source = await scene(server, cookie);
  const dub = (await server.api(`/api/my/projects/from/${source.id}`, { method: 'POST', cookie })).data;
  const line = `/api/my/projects/${dub.id}/segments/${dub.segments[0].id}`;
  for (let i = 0; i < 2; i++) assert.equal((await server.api(line + '/audio?fileName=take.wav', { method: 'POST', cookie, body: bytes })).status, 201);
  assert.equal((await server.api(line + '/audio?fileName=take.wav', { method: 'POST', cookie, body: bytes })).status, 413);
  const current = (await server.api('/api/my/projects', { cookie })).data.find(p => p.id === dub.id);
  assert.equal(current.segments[0].takes.length, 2);
  assert.equal((await readdir(path.join(server.dir, 'uploads'))).length, 3);
});

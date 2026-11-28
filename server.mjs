import { createServer } from 'node:http';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { randomBytes, randomUUID, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, fail } from './lib/store.mjs';
import { inspectMedia, mediaMime } from './lib/media.mjs';
import { takesFor, ensureTakes, selectTake, saveTakeEdits, projectFiles } from './lib/takes.mjs';

const scrypt = promisify(scryptCallback);
const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const uploadDir = path.join(dataDir, 'uploads');
await fs.mkdir(uploadDir, { recursive: true });
const store = await openStore();
const maxVideoBytes = Number(process.env.MAX_UPLOAD_BYTES || 800 * 1024 * 1024);
const maxAudioBytes = 96 * 1024 * 1024;
const maxStorageBytes = Number(process.env.MAX_USER_STORAGE_BYTES || 5 * 1024 ** 3);
const videoExtensions = new Set(['.mp4', '.webm', '.mov', '.m4v']);
const audioExtensions = new Set(['.mp3', '.wav', '.ogg', '.webm', '.m4a', '.aac']);
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const now = () => new Date().toISOString();
const hash = token => createHash('sha256').update(token).digest('hex');
const activeUploads = new Map();
const attempts = new Map();

function json(res, status, value, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(value));
}
function cookie(req) {
  const part = (req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith('replica_session='));
  try { return part ? decodeURIComponent(part.slice(16)) : ''; } catch { return ''; }
}
async function currentUser(req) { return store.sessionUser(hash(cookie(req))); }
async function requireUser(req, role) {
  const user = await currentUser(req);
  if (!user) throw fail(401, 'Войдите в аккаунт, чтобы продолжить');
  if (role && user.role !== role) throw fail(403, 'Это действие доступно администратору');
  return user;
}
function userView(user) { return { id: user.id, name: user.name, email: user.email, role: user.role }; }
function sessionCookie(token, req, age = 2592000) {
  const secure = process.env.NODE_ENV === 'production' || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `replica_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure}`;
}
async function login(user, req, res, status = 200) {
  const token = randomBytes(32).toString('hex');
  await store.transaction(async tx => { await tx.pruneSessions(); await tx.deleteSession(hash(cookie(req))); await tx.addSession(hash(token), user.id, Date.now() + 2592000000); });
  return json(res, status, { user: userView(user) }, { 'Set-Cookie': sessionCookie(token, req) });
}
function rateLimit(req) {
  const address = process.env.TRUST_PROXY === '1' ? req.headers['x-forwarded-for']?.split(',').at(-1).trim() || req.socket.remoteAddress : req.socket.remoteAddress;
  const time = Date.now();
  for (const [key, entry] of attempts) if (entry.expires <= time) attempts.delete(key);
  const entry = attempts.get(address) || { count: 0, expires: time + 600000 };
  if (++entry.count > 30) throw fail(429, 'Слишком много попыток. Попробуйте через 10 минут.');
  attempts.set(address, entry);
}
async function readJson(req, limit = 2_000_000) {
  const chunks = []; let total = 0;
  for await (const chunk of req) { total += chunk.length; if (total > limit) throw fail(413, 'Слишком большой запрос'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw fail(400, 'Некорректный JSON'); }
}
function accessible(item, user) {
  if (!item || (user.role !== 'admin' && item.ownerId !== user.id)) throw fail(404, 'Проект не найден');
  return item;
}
function editable(item, user) {
  accessible(item, user);
  if (!['draft', 'rejected'].includes(item.status)) throw fail(409, 'Сначала верните проект на правки. Отправленный или опубликованный проект закрыт для редактирования.');
  return item;
}
function version(req, item) {
  const value = req.headers['x-project-version'];
  return value === undefined ? item.revision : Number(value);
}
function cleanName(name) { return path.basename(name || '').replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 120) || 'media'; }
function privateProject(item) {
  return { ...item, segments: (item.segments || []).map(segment => { const result = { ...segment }; ensureTakes(result); return result; }), videoUrl: `/api/my/projects/${item.id}/file`, mixUrl: item.mixFile ? `/api/my/projects/${item.id}/mix` : null };
}
function publicProject(item) {
  return { id: item.id, projectType: item.projectType || 'scene', title: item.title, description: item.description, ownerName: item.ownerName, createdAt: item.createdAt, duration: item.duration, sourceSceneId: item.sourceSceneId, mixUrl: item.mixFile ? `/api/videos/${item.id}/mix` : null, segments: (item.segments || []).map(s => ({ id: s.id, start: s.start, end: s.end, role: s.role, text: s.text })), videoUrl: `/api/videos/${item.id}/file` };
}
async function publicAccess(item) {
  if (!item?.published) return false;
  return item.projectType !== 'dub' || Boolean((await store.getProject(item.sourceSceneId))?.published);
}
function clearMix(item) { delete item.mixFile; delete item.mixCreatedAt; delete item.mixName; delete item.mixBytes; }
function parseTime(value) {
  if (typeof value === 'number') return value;
  const match = typeof value === 'string' && value.match(/^(\d{2,}):([0-5]\d):([0-5]\d(?:\.\d{1,3})?)$/);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : NaN;
}
function normalizeSegments(input, item) {
  if (!Array.isArray(input) || input.length > 500) throw fail(422, 'Ожидался список не более 500 реплик');
  const previous = new Map((item.segments || []).map(s => [s.id, s])); const ids = new Set();
  return input.map(value => {
    if (!value || typeof value !== 'object') throw fail(422, 'Некорректная реплика');
    const id = String(value.id || randomUUID());
    const start = parseTime(value.start), end = parseTime(value.end);
    const text = String(value.text || '').trim(), role = String(value.role || '').trim();
    if (!/^[\w-]{1,100}$/.test(id) || ids.has(id)) throw fail(422, 'Идентификаторы реплик должны быть уникальными');
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > item.duration + .001) throw fail(422, 'Таймкоды реплики должны находиться внутри видео; конец — позже начала');
    if (!text || text.length > 2000 || role.length > 100) throw fail(422, 'Укажите текст реплики до 2000 символов и роль до 100 символов');
    ids.add(id);
    const old = previous.get(id);
    const offset = Number(value.voiceOffset ?? old?.voiceOffset ?? 0);
    if (!Number.isFinite(offset) || start + offset < 0 || start + offset >= end) throw fail(422, 'Начало дубля должно находиться до конца реплики и внутри видео');
    const trimStart = Number(value.voiceTrimStart ?? old?.voiceTrimStart ?? 0);
    const trimEnd = Number(value.voiceTrimEnd ?? old?.voiceTrimEnd ?? 0);
    if (![trimStart, trimEnd].every(n => Number.isFinite(n) && n >= 0)) throw fail(422, 'Обрезка должна быть задана неотрицательным числом секунд');
    if ((trimStart || trimEnd) && (!old?.voiceFile || !Number.isFinite(old.voiceDuration) || trimStart + trimEnd >= old.voiceDuration)) throw fail(422, 'Обрезка должна оставлять часть исходной записи');
    const result = { ...old, id, start, end, text, role, voiceOffset: offset, voiceTrimStart: trimStart, voiceTrimEnd: trimEnd };
    saveTakeEdits(result); return result;
  }).sort((a, b) => a.start - b.start);
}
async function withDuration(item) {
  if (item.duration) return item;
  const info = await inspectMedia(path.join(uploadDir, item.diskName), 'video');
  // Metadata migration does not overwrite edits or change the content revision.
  return store.transaction(async tx => { const fresh = await tx.getProject(item.id); if (!fresh) throw fail(404, 'Проект не найден'); fresh.duration = info.duration; fresh.videoBytes = info.bytes; await tx.putProject(fresh); return fresh; });
}
function ready(item) {
  if (!item.segments?.length) throw fail(422, 'Добавьте хотя бы одну реплику');
  normalizeSegments(item.segments, item);
  if (item.projectType === 'dub') {
    if (item.segments.some(s => !s.voiceFile)) throw fail(422, 'Запишите каждую реплику');
    if (!item.mixFile) throw fail(422, 'Сначала соберите итоговую звуковую дорожку');
  }
}
async function checkQuota(tx, userId, extraBytes = 0) {
  const used = (await tx.projects()).filter(p => p.ownerId === userId).reduce((sum, p) => sum + (p.projectType === 'dub' ? 0 : p.videoBytes || 0) + (p.mixBytes || 0) + (p.segments || []).reduce((n, s) => n + takesFor(s).reduce((bytes, take) => bytes + (take.voiceBytes || 0), 0), 0), 0);
  if (used + extraBytes > maxStorageBytes) throw fail(413, 'Превышен лимит хранения. Удалите ненужные черновики.');
}
async function upload(req, user, name, kind, commit, storageOwner = user.id) {
  if ((activeUploads.get(user.id) || 0) >= 2) throw fail(429, 'Дождитесь окончания текущих загрузок');
  const ext = path.extname(cleanName(name)).toLowerCase();
  if (!(kind === 'video' ? videoExtensions : audioExtensions).has(ext)) throw fail(415, 'Неподдерживаемый формат файла');
  const diskName = `${randomUUID()}${ext}`, destination = path.join(uploadDir, diskName);
  activeUploads.set(user.id, (activeUploads.get(user.id) || 0) + 1);
  let committed = false;
  try {
    let bytes = 0; const limit = kind === 'video' ? maxVideoBytes : maxAudioBytes;
    if (Number(req.headers['content-length']) > limit) throw fail(413, 'Файл превышает допустимый размер');
    const limiter = new Transform({ transform(chunk, encoding, callback) { bytes += chunk.length; callback(bytes > limit ? fail(413, 'Файл превышает допустимый размер') : null, chunk); } });
    await pipeline(req, limiter, createWriteStream(destination, { flags: 'wx' }));
    const info = await inspectMedia(destination, kind);
    const result = await store.transaction(async tx => { await tx.user(storageOwner); await checkQuota(tx, storageOwner, bytes); return commit(diskName, info, tx); });
    committed = projectFiles(result).includes(diskName); return result;
  } finally {
    activeUploads.set(user.id, Math.max(0, (activeUploads.get(user.id) || 1) - 1));
    if (!committed) await fs.rm(destination, { force: true });
  }
}
// Delete only files detached by a completed transaction; never delete an in-flight upload.
async function cleanDetached(before, after) {
  const files = projectFiles;
  const referenced = new Set((await store.projects()).flatMap(files));
  for (const file of files(before)) if (!files(after).includes(file) && !referenced.has(file)) await fs.rm(path.join(uploadDir, file), { force: true }).catch(error => console.error('Media cleanup:', error.message));
}
async function sendMedia(req, res, diskName, kind) {
  const file = path.join(uploadDir, path.basename(diskName));
  let stat; try { stat = await fs.stat(file); } catch { throw fail(404, 'Медиафайл не найден'); }
  const headers = { 'Content-Type': mediaMime(file, kind), 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "sandbox; default-src 'none'" };
  let start = 0, end = stat.size - 1, status = 200;
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); }
    start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]));
    end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); }
    headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`; status = 206;
  }
  res.writeHead(status, { ...headers, 'Content-Length': end - start + 1 });
  const stream = createReadStream(file, { start, end });
  stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
}

const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);
    if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin) {
      let origin; try { origin = new URL(req.headers.origin); } catch { throw fail(403, 'Недопустимый источник запроса'); }
      if (origin.host !== req.headers.host) throw fail(403, 'Недопустимый источник запроса');
    }
    if (req.method === 'GET' && pathname === '/api/auth/me') { const user = await currentUser(req); return json(res, 200, { user: user ? userView(user) : null }); }
    if (req.method === 'POST' && ['/api/auth/register', '/api/auth/login'].includes(pathname)) {
      rateLimit(req);
      const body = await readJson(req, 20000);
      const email = String(body.email || '').trim().toLowerCase(); const password = String(body.password || '');
      if (password.length > 1024) throw fail(400, 'Пароль слишком длинный');
      if (pathname.endsWith('register')) {
        const name = String(body.name || '').trim();
        if (!name) throw fail(400, 'Укажите имя или псевдоним');
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail(400, 'Укажите корректный email, например name@example.com');
        if (password.length < 8) throw fail(400, 'Пароль должен содержать не менее 8 символов');
        const salt = randomBytes(16).toString('hex'); const passwordHash = (await scrypt(password, salt, 64)).toString('hex');
        const user = { id: randomUUID(), name, email, salt, passwordHash, role: 'member', createdAt: now() };
        await store.insertUser(user);
        return await login(user, req, res, 201);
      }
      const user = await store.userByEmail(email);
      const actual = await scrypt(password, user?.salt || 'replica-invalid-account', 64);
      if (!user || !timingSafeEqual(actual, Buffer.from(user.passwordHash, 'hex'))) throw fail(401, 'Почта или пароль не подошли');
      return await login(user, req, res);
    }
    if (req.method === 'POST' && pathname === '/api/auth/logout') {
      await store.deleteSession(hash(cookie(req)));
      return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', req, 0) });
    }
    if (req.method === 'GET' && pathname === '/api/videos') {
      const items = await store.projects();
      return json(res, 200, items.filter(p => p.published && p.projectType !== 'dub').map(scene => ({ ...publicProject(scene), dubs: items.filter(p => p.published && p.projectType === 'dub' && p.sourceSceneId === scene.id && p.mixFile).map(publicProject) })));
    }
    const publicMedia = pathname.match(/^\/api\/videos\/([\w-]+)\/(file|mix|segments\/([\w-]+)\/audio)$/);
    if (req.method === 'GET' && publicMedia) {
      const item = await store.getProject(publicMedia[1]); if (!await publicAccess(item)) throw fail(404, 'Публикация не найдена');
      const file = publicMedia[2] === 'file' ? item.diskName : publicMedia[2] === 'mix' ? item.mixFile : item.segments.find(s => s.id === publicMedia[3])?.voiceFile;
      if (!file) throw fail(404, 'Медиафайл не найден'); return await sendMedia(req, res, file, publicMedia[2] === 'file' ? 'video' : 'audio');
    }
    if (req.method === 'GET' && ['/api/my/projects', '/api/admin/videos'].includes(pathname)) {
      const admin = pathname.includes('/admin/'), user = await requireUser(req, admin ? 'admin' : undefined);
      return json(res, 200, (await store.projects()).filter(p => admin || p.ownerId === user.id).map(privateProject));
    }
    if (req.method === 'POST' && ['/api/my/projects', '/api/admin/videos'].includes(pathname)) {
      const user = await requireUser(req, pathname.includes('/admin/') ? 'admin' : undefined);
      const title = String(url.searchParams.get('title') || '').trim().slice(0, 140);
      if (!title) throw fail(400, 'Добавьте название сцены');
      const fileName = cleanName(url.searchParams.get('fileName'));
      const item = await upload(req, user, fileName, 'video', async (diskName, info, tx) => {
        if ((await tx.projects()).filter(p => p.ownerId === user.id).length >= 100) throw fail(413, 'Лимит — 100 проектов на пользователя');
        const project = { id: randomUUID(), revision: 1, projectType: 'scene', title, description: String(url.searchParams.get('description') || '').slice(0, 1200), fileName, diskName, duration: info.duration, videoBytes: info.bytes, ownerId: user.id, ownerName: user.name, createdAt: now(), status: 'draft', published: false, segments: [] };
        await tx.putProject(project); return project;
      });
      return json(res, 201, privateProject(item));
    }
    const remix = pathname.match(/^\/api\/my\/projects\/from\/([\w-]+)$/);
    if (req.method === 'POST' && remix) {
      const user = await requireUser(req);
      const initial = await store.getProject(remix[1]);
      if (!initial || !(initial.published || initial.ownerId === user.id) || initial.projectType === 'dub' || !initial.segments?.length) throw fail(404, 'Сцена не найдена или в ней ещё нет реплик');
      await withDuration(initial);
      const item = await store.transaction(async tx => {
        await tx.user(user.id);
        const source = await tx.getProject(initial.id);
        if (!source || !(source.published || source.ownerId === user.id)) throw fail(404, 'Сцена больше недоступна');
        const existing = (await tx.projects()).find(p => p.ownerId === user.id && p.sourceSceneId === source.id && ['draft', 'rejected'].includes(p.status));
        if (existing) return existing;
        if ((await tx.projects()).filter(p => p.ownerId === user.id).length >= 100) throw fail(413, 'Лимит — 100 проектов на пользователя');
        const dub = { id: randomUUID(), revision: 1, projectType: 'dub', title: `Озвучка — ${source.title}`.slice(0, 140), description: source.description, fileName: source.fileName, diskName: source.diskName, duration: source.duration, sourceSceneId: source.id, sourceRevision: source.revision, ownerId: user.id, ownerName: user.name, createdAt: now(), status: 'draft', published: false, segments: source.segments.map(s => ({ id: randomUUID(), sourceSegmentId: s.id, start: s.start, end: s.end, voiceOffset: 0, role: s.role, text: s.text })) };
        await tx.putProject(dub); return dub;
      }); return json(res, 201, privateProject(item));
    }
    const takeRoute = pathname.match(/^\/api\/(my\/projects|admin\/videos)\/([\w-]+)\/segments\/([\w-]+)\/takes\/([\w-]+)\/(audio|select)$/);
    if (takeRoute && ((req.method === 'GET' && takeRoute[5] === 'audio') || (req.method === 'POST' && takeRoute[5] === 'select'))) {
      const user = await requireUser(req, takeRoute[1].startsWith('admin') ? 'admin' : undefined);
      const item = accessible(await store.getProject(takeRoute[2]), user);
      const segment = item.segments.find(s => s.id === takeRoute[3]);
      const take = segment && takesFor(segment).find(t => t.id === takeRoute[4]);
      if (!take) throw fail(404, 'Дубль не найден');
      if (req.method === 'GET') return await sendMedia(req, res, take.voiceFile, 'audio');
      await readJson(req);
      const updated = await store.mutate(item.id, version(req, item), fresh => {
        editable(fresh, user);
        const target = fresh.segments.find(s => s.id === takeRoute[3]);
        if (!target || !selectTake(target, takeRoute[4])) throw fail(404, 'Дубль не найден');
        clearMix(fresh);
      });
      await cleanDetached(item, updated); return json(res, 200, privateProject(updated));
    }
    const privateMedia = pathname.match(/^\/api\/(my\/projects|admin\/videos)\/([\w-]+)\/(file|mix|segments\/([\w-]+)\/audio)$/);
    if (req.method === 'GET' && privateMedia) {
      const user = await requireUser(req, privateMedia[1].startsWith('admin') ? 'admin' : undefined);
      const item = accessible(await store.getProject(privateMedia[2]), user);
      const file = privateMedia[3] === 'file' ? item.diskName : privateMedia[3] === 'mix' ? item.mixFile : item.segments.find(s => s.id === privateMedia[4])?.voiceFile;
      if (!file) throw fail(404, 'Медиафайл не найден'); return await sendMedia(req, res, file, privateMedia[3] === 'file' ? 'video' : 'audio');
    }
    const projectRoute = pathname.match(/^\/api\/(my\/projects|admin\/videos)\/([\w-]+)(?:\/(segments|submit|publish|reject|mix|mixdown|segments\/([\w-]+)\/audio))?$/);
    if (projectRoute && ['PUT', 'POST', 'DELETE'].includes(req.method)) {
      const admin = projectRoute[1].startsWith('admin');
      const user = await requireUser(req, admin ? 'admin' : undefined);
      let item = accessible(await store.getProject(projectRoute[2]), user);
      const action = projectRoute[3] || '', expected = version(req, item);
      if (req.method === 'DELETE' && !action) {
        if (!admin) editable(item, user);
        await store.transaction(async tx => {
          const fresh = accessible(await tx.getProject(item.id), user);
          if (fresh.revision !== expected) throw fail(409, 'Проект изменён. Обновите страницу.');
          if ((await tx.projects()).some(p => p.sourceSceneId === item.id)) throw fail(409, 'У сцены есть озвучки. Сначала удалите связанные озвучки.');
          await tx.deleteProject(item.id);
        }); await cleanDetached(item, null); return json(res, 200, { ok: true });
      }
      if (req.method === 'PUT' && ((!admin && !action) || (admin && action === 'segments'))) {
        editable(item, user); const body = await readJson(req); item = await withDuration(item);
        const updated = await store.mutate(item.id, Number(body.revision), fresh => { editable(fresh, user); fresh.segments = normalizeSegments(body.segments, fresh); clearMix(fresh); });
        await cleanDetached(item, updated); return json(res, 200, privateProject(updated));
      }
      if (req.method === 'POST' && (action === 'mix' || action === 'mixdown' || projectRoute[4])) {
        editable(item, user); if (item.projectType !== 'dub') throw fail(422, 'Запись голоса доступна в проекте озвучки');
        const segmentId = projectRoute[4], isMix = !segmentId;
        if (segmentId && !item.segments.some(s => s.id === segmentId)) throw fail(404, 'Реплика не найдена');
        if (isMix && item.segments.some(s => !s.voiceFile)) throw fail(422, 'Сначала запишите все реплики');
        const name = isMix ? 'mix.wav' : cleanName(url.searchParams.get('fileName'));
        const takeId = isMix ? null : url.searchParams.get('takeId') || randomUUID();
        if (takeId && !/^[\w-]{1,100}$/.test(takeId)) throw fail(422, 'Некорректный идентификатор дубля');
        if (segmentId && takesFor(item.segments.find(s => s.id === segmentId)).some(t => t.id === takeId)) {
          req.resume(); return json(res, 201, privateProject(item));
        }
        const updated = await upload(req, user, name, 'audio', async (file, info, tx) => {
          const fresh = editable(await tx.getProject(item.id), user);
          if (segmentId && takesFor(fresh.segments.find(s => s.id === segmentId) || {}).some(t => t.id === takeId)) return fresh;
          if (fresh.revision !== expected) throw fail(409, 'Проект изменён во время загрузки. Обновите страницу и повторите сохранение.');
          clearMix(fresh);
          if (isMix) { fresh.mixFile = file; fresh.mixBytes = info.bytes; fresh.mixName = `${cleanName(fresh.title)}.wav`; fresh.mixCreatedAt = now(); }
          else {
            const segment = fresh.segments.find(s => s.id === segmentId); if (!segment) throw fail(409, 'Реплика удалена');
            ensureTakes(segment).push({ id: takeId, createdAt: now(), voiceFile: file, voiceName: name, voiceDuration: info.duration, voiceBytes: info.bytes, voiceTrimStart: 0, voiceTrimEnd: 0, voiceOffset: 0 });
            selectTake(segment, takeId);
          }
          fresh.revision++; fresh.updatedAt = now(); await tx.putProject(fresh); return fresh;
        }, item.ownerId);
        await cleanDetached(item, updated); return json(res, 201, privateProject(updated));
      }
      if (req.method === 'POST' && ((action === 'submit' && !admin) || (admin && ['publish', 'reject'].includes(action)))) {
        const body = await readJson(req); item = await withDuration(item);
        const updated = await store.mutate(item.id, expected, async (fresh, tx) => {
          if (action === 'submit') { editable(fresh, user); ready(fresh); fresh.status = 'submitted'; fresh.submittedAt = now(); fresh.published = false; }
          else {
            if (action === 'publish') {
              ready(fresh);
              if (!['draft', 'submitted'].includes(fresh.status)) throw fail(409, 'Дождитесь повторной отправки проекта на проверку');
              if (fresh.projectType === 'dub' && !(await tx.getProject(fresh.sourceSceneId))?.published) throw fail(422, 'Сначала опубликуйте исходную сцену');
            }
            const comment = String(body.comment || '').trim().slice(0, 2000);
            if (action === 'reject' && !comment) throw fail(422, 'Укажите, что автору нужно исправить');
            fresh.status = action === 'publish' ? 'published' : 'rejected'; fresh.published = action === 'publish'; fresh.reviewedAt = now(); fresh.reviewComment = comment;
            fresh.reviewHistory = [...(fresh.reviewHistory || []), { action, comment, reviewerId: user.id, at: fresh.reviewedAt }];
          }
        }); return json(res, 200, privateProject(updated));
      }
    }
    if (req.method === 'GET') {
      const user = await currentUser(req);
      if (['/admin', '/workspace', '/workspace/create', '/workspace/segment', '/workspace/dub'].includes(pathname)) { res.writeHead(302, { Location: `${pathname}/${url.search}` }); return res.end(); }
      if ((pathname.startsWith('/workspace/') || pathname === '/admin/') && !user) { res.writeHead(302, { Location: `/login/?next=${encodeURIComponent(pathname + url.search)}` }); return res.end(); }
      if (pathname === '/admin/' && user.role !== 'admin') { res.writeHead(302, { Location: '/workspace/' }); return res.end(); }
      const pages = { '/': 'index.html', '/admin/': 'admin.html', '/workspace/': 'workspace-home.html', '/workspace/create/': 'upload.html', '/workspace/segment/': 'workspace.html', '/workspace/dub/': 'dub.html', '/login/': 'login.html', '/register/': 'register.html' };
      const file = path.resolve(publicDir, pages[pathname] || pathname.slice(1));
      if (!file.startsWith(publicDir + path.sep)) throw fail(403, 'Запрещено');
      let stat; try { stat = await fs.stat(file); } catch { throw fail(404, 'Не найдено'); }
      if (!stat.isFile()) throw fail(404, 'Не найдено');
      res.writeHead(200, { 'Content-Type': mimeTypes[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      const stream = createReadStream(file); stream.on('error', () => res.destroy()); return stream.pipe(res);
    }
    throw fail(404, 'Маршрут не найден');
  } catch (error) {
    if (!error.status) console.error(error);
    if (!res.headersSent && !res.destroyed) json(res, error.status || 500, { error: error.status ? error.message : 'Внутренняя ошибка сервера' }); else res.destroy();
  }
});
server.listen(Number(process.env.PORT || 3000), process.env.HOST || '0.0.0.0', () => console.log(`Реплика работает: http://localhost:${server.address().port}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(async () => { await store.close(); process.exit(0); }));

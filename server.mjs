import { createServer } from 'node:http';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scrypt = promisify(scryptCallback);
const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const uploadDir = path.join(dataDir, 'uploads');
const catalogPath = path.join(dataDir, 'catalog.json');
const usersPath = path.join(dataDir, 'users.json');
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const maxVideoBytes = Number(process.env.MAX_UPLOAD_BYTES || 800 * 1024 * 1024);
const maxAudioBytes = 32 * 1024 * 1024;
const sessions = new Map();
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const videoExtensions = new Set(['.mp4', '.webm', '.mov', '.m4v']);
const audioExtensions = new Set(['.mp3', '.wav', '.ogg', '.webm', '.m4a', '.aac']);

await fs.mkdir(uploadDir, { recursive: true });
for (const [file, initial] of [[catalogPath, '[]'], [usersPath, '[]']]) {
  try { await fs.access(file); } catch { await fs.writeFile(file, initial); }
}

async function readStore(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function saveStore(file, value) { await fs.writeFile(file, JSON.stringify(value, null, 2)); }
const readCatalog = () => readStore(catalogPath);
const saveCatalog = value => saveStore(catalogPath, value);
const readUsers = () => readStore(usersPath);
const saveUsers = value => saveStore(usersPath, value);
function json(res, status, value, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(JSON.stringify(value));
}
function cookie(req, name) {
  const part = (req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : '';
}
async function currentUser(req) {
  const userId = sessions.get(cookie(req, 'replica_session'));
  if (!userId) return null;
  return (await readUsers()).find(user => user.id === userId) || null;
}
function userView(user) { return { id: user.id, name: user.name, email: user.email, role: user.role }; }
function sessionCookie(sessionId, req) {
  const secure = process.env.NODE_ENV === 'production' || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `replica_session=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`;
}
async function requireUser(req, res, role) {
  const user = await currentUser(req);
  if (!user) { json(res, 401, { error: 'Войдите в аккаунт, чтобы продолжить' }); return null; }
  if (role === 'admin' && user.role !== 'admin') { json(res, 403, { error: 'Это действие доступно администратору' }); return null; }
  return user;
}
function cleanFileName(name) { return path.basename(name || '').replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 120) || 'media'; }
function parseTimeValue(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^\d{2,}:[0-5]\d:[0-5]\d$/.test(value)) {
    const [hours, minutes, seconds] = value.split(':').map(Number);
    return hours * 3600 + minutes * 60 + seconds;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}
function readJson(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > limit) { reject(new Error('Слишком большой запрос')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Некорректный JSON')); } });
    req.on('error', reject);
  });
}
async function receiveFile(req, destination, limit) {
  let total = 0;
  const limiter = new Transform({ transform(chunk, encoding, callback) { total += chunk.length; if (total > limit) return callback(new Error('Файл превышает допустимый размер')); callback(null, chunk); } });
  try { await pipeline(req, limiter, createWriteStream(destination, { flags: 'wx' })); }
  catch (error) { await fs.rm(destination, { force: true }); throw error; }
  if (!total) { await fs.rm(destination, { force: true }); throw new Error('Выбранный файл пуст'); }
  return total;
}
function sendMedia(req, res, file, mimeType) {
  fs.stat(file).then(stat => {
    const range = req.headers.range;
    if (range) {
      const [startRaw, endRaw] = range.replace(/bytes=/, '').split('-');
      const start = Number(startRaw);
      const end = Math.min(endRaw ? Number(endRaw) : stat.size - 1, stat.size - 1);
      if (!Number.isFinite(start) || start < 0 || start >= stat.size || end < start) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end();
      }
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': mimeType });
      createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'Content-Type': mimeType });
      createReadStream(file).pipe(res);
    }
  }).catch(() => json(res, 404, { error: 'Медиафайл не найден' }));
}
function mimeFor(file, kind) {
  const ext = path.extname(file).toLowerCase();
  if (kind === 'audio') return ({ '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.webm': 'audio/webm', '.m4a': 'audio/mp4', '.aac': 'audio/aac' })[ext] || 'application/octet-stream';
  return ({ '.mov': 'video/quicktime', '.webm': 'video/webm', '.m4v': 'video/mp4' })[ext] || 'video/mp4';
}
function publicProject(item) {
  return { id: item.id, title: item.title, description: item.description, fileName: item.fileName, createdAt: item.createdAt, mixUrl: item.mixFile ? `/api/videos/${item.id}/mix` : null, segments: (item.segments || []).map(segment => ({ id: segment.id, start: segment.start, end: segment.end, voiceOffset: segment.voiceOffset || 0, role: segment.role, text: segment.text, audioUrl: segment.voiceFile ? `/api/videos/${item.id}/segments/${segment.id}/audio` : null })), videoUrl: `/api/videos/${item.id}/file` };
}
function ownerCanAccess(item, user) { return user?.role === 'admin' || item?.ownerId === user?.id; }
async function getProject(id) { return (await readCatalog()).find(item => item.id === id); }
function fileSuffix(name, allowed) { const ext = path.extname(cleanFileName(name)).toLowerCase(); return allowed.has(ext) ? ext : ''; }
async function clearMix(item) {
  if (item?.mixFile) await fs.rm(path.join(uploadDir, item.mixFile), { force: true });
  if (item) { delete item.mixFile; delete item.mixMime; delete item.mixName; delete item.mixCreatedAt; }
}
async function removeUnusedProjectFiles(item, remaining) {
  if (!remaining.some(project => project.diskName === item.diskName)) await fs.rm(path.join(uploadDir, item.diskName), { force: true });
  const remainingVoices = new Set(remaining.flatMap(project => (project.segments || []).map(segment => segment.voiceFile).filter(Boolean)));
  for (const segment of item.segments || []) if (segment.voiceFile && !remainingVoices.has(segment.voiceFile)) await fs.rm(path.join(uploadDir, segment.voiceFile), { force: true });
  const remainingMixes = new Set(remaining.map(project => project.mixFile).filter(Boolean));
  if (item.mixFile && !remainingMixes.has(item.mixFile)) await fs.rm(path.join(uploadDir, item.mixFile), { force: true });
}
function normalizedSegments(input, previous = []) {
  const audioById = new Map(previous.map(segment => [segment.id, segment]));
  return input.map(value => {
    const id = String(value.id || randomUUID());
    const start = parseTimeValue(value.start);
    const end = parseTimeValue(value.end);
    const audio = audioById.get(id);
    const requestedOffset = Number(value.voiceOffset ?? audio?.voiceOffset ?? 0);
    const voiceOffset = Number.isFinite(requestedOffset) ? Math.max(-start, Math.min(86400, requestedOffset)) : 0;
    return { id, start, end, voiceOffset, role: String(value.role || '').slice(0, 100), text: String(value.text || '').slice(0, 2000), ...(audio?.voiceFile ? { voiceFile: audio.voiceFile, voiceName: audio.voiceName, voiceMime: audio.voiceMime } : {}) };
  }).filter(segment => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.start >= 0 && segment.end > segment.start && segment.text.trim()).sort((a, b) => a.start - b.start);
}
function adminPageRedirect(user) { return user?.role === 'admin' ? '/admin/' : '/workspace/'; }

const server = createServer(async (req, res) => {
  let url, pathname;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); pathname = decodeURIComponent(url.pathname); }
  catch { return json(res, 400, { error: 'Некорректный адрес запроса' }); }
  try {
    // Authentication and account routes.
    if (req.method === 'GET' && pathname === '/api/auth/me') {
      const user = await currentUser(req); return json(res, 200, { user: user ? userView(user) : null });
    }
    if (req.method === 'POST' && pathname === '/api/auth/register') {
      const body = await readJson(req, 20_000);
      const name = String(body.name || '').trim().slice(0, 60);
      const email = String(body.email || '').trim().toLowerCase().slice(0, 180);
      const password = String(body.password || '');
      if (name.length < 2) return json(res, 400, { error: 'Введите имя длиной хотя бы 2 символа' });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { error: 'Проверьте адрес электронной почты' });
      if (password.length < 8) return json(res, 400, { error: 'Пароль должен содержать не менее 8 символов' });
      const users = await readUsers();
      if (users.some(user => user.email === email)) return json(res, 409, { error: 'Аккаунт с такой почтой уже существует' });
      const salt = randomBytes(16).toString('hex');
      const passwordHash = (await scrypt(password, salt, 64)).toString('hex');
      const user = { id: randomUUID(), name, email, salt, passwordHash, role: users.length === 0 ? 'admin' : 'member', createdAt: new Date().toISOString() };
      users.push(user); await saveUsers(users);
      const session = randomBytes(32).toString('hex'); sessions.set(session, user.id);
      return json(res, 201, { user: userView(user) }, { 'Set-Cookie': sessionCookie(session, req) });
    }
    if (req.method === 'POST' && pathname === '/api/auth/login') {
      const body = await readJson(req, 20_000);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const user = (await readUsers()).find(value => value.email === email);
      if (!user || !timingSafeEqual(Buffer.from((await scrypt(password, user.salt, 64)).toString('hex')), Buffer.from(user.passwordHash))) return json(res, 401, { error: 'Почта или пароль не подошли' });
      const session = randomBytes(32).toString('hex'); sessions.set(session, user.id);
      return json(res, 200, { user: userView(user) }, { 'Set-Cookie': sessionCookie(session, req) });
    }
    if (req.method === 'POST' && pathname === '/api/auth/logout') {
      sessions.delete(cookie(req, 'replica_session'));
      return json(res, 200, { ok: true }, { 'Set-Cookie': `replica_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${process.env.NODE_ENV === 'production' ? '; Secure' : ''}` });
    }

    // Public catalog contains only administrator-published projects and reviewed user submissions.
    if (req.method === 'GET' && pathname === '/api/videos') {
      const items = (await readCatalog()).filter(item => item.published);
      return json(res, 200, items.map(publicProject));
    }
    const publicMixMatch = pathname.match(/^\/api\/videos\/([\w-]+)\/mix$/);
    if (req.method === 'GET' && publicMixMatch) {
      const item = await getProject(publicMixMatch[1]);
      if (!item?.published || !item.mixFile) return json(res, 404, { error: 'Итоговая дорожка не опубликована' });
      return sendMedia(req, res, path.join(uploadDir, item.mixFile), item.mixMime || 'audio/wav');
    }
    const publicFileMatch = pathname.match(/^\/api\/videos\/([\w-]+)\/file$/);
    if (req.method === 'GET' && publicFileMatch) {
      const item = await getProject(publicFileMatch[1]);
      if (!item?.published) return json(res, 404, { error: 'Видео не найдено' });
      return sendMedia(req, res, path.join(uploadDir, item.diskName), mimeFor(item.diskName, 'video'));
    }
    const publicAudioMatch = pathname.match(/^\/api\/videos\/([\w-]+)\/segments\/([\w-]+)\/audio$/);
    if (req.method === 'GET' && publicAudioMatch) {
      const item = await getProject(publicAudioMatch[1]);
      const segment = item?.segments?.find(value => value.id === publicAudioMatch[2]);
      if (!item?.published || !segment?.voiceFile) return json(res, 404, { error: 'Озвучка не найдена' });
      return sendMedia(req, res, path.join(uploadDir, segment.voiceFile), segment.voiceMime || mimeFor(segment.voiceFile, 'audio'));
    }

    // Personal workspace: user clips are private drafts until submitted for review.
    if (req.method === 'GET' && pathname === '/api/my/projects') {
      const user = await requireUser(req, res); if (!user) return;
      const items = (await readCatalog()).filter(item => item.ownerId === user.id);
      return json(res, 200, items.map(item => ({ ...item, videoUrl: `/api/my/projects/${item.id}/file`, mixUrl: item.mixFile ? `/api/my/projects/${item.id}/mix` : null })));
    }
    if (req.method === 'POST' && pathname === '/api/my/projects') {
      const user = await requireUser(req, res); if (!user) return;
      const title = String(url.searchParams.get('title') || '').trim().slice(0, 140);
      const description = String(url.searchParams.get('description') || '').trim().slice(0, 1200);
      const originalName = cleanFileName(url.searchParams.get('fileName') || 'scene.mp4');
      const ext = fileSuffix(originalName, videoExtensions);
      if (!title) return json(res, 400, { error: 'Добавьте название сцены' });
      if (!ext) return json(res, 415, { error: 'Поддерживаются MP4, WebM, MOV и M4V' });
      const id = randomUUID(); const diskName = `${id}${ext}`;
      await receiveFile(req, path.join(uploadDir, diskName), maxVideoBytes);
      const item = { id, projectType: 'scene', title, description, fileName: originalName, diskName, ownerId: user.id, ownerName: user.name, createdAt: new Date().toISOString(), status: 'draft', published: false, segments: [] };
      const items = await readCatalog(); items.unshift(item); await saveCatalog(items);
      return json(res, 201, { ...item, videoUrl: `/api/my/projects/${id}/file` });
    }
    const remixMatch = pathname.match(/^\/api\/my\/projects\/from\/([\w-]+)$/);
    if (req.method === 'POST' && remixMatch) {
      const user = await requireUser(req, res); if (!user) return;
      const items = await readCatalog();
      const source = items.find(value => value.id === remixMatch[1] && (value.published || value.ownerId === user.id) && value.projectType !== 'dub' && value.segments?.length);
      if (!source) return json(res, 404, { error: 'Сцена не найдена или в ней ещё нет реплик' });
      const existing = items.find(value => value.ownerId === user.id && value.projectType === 'dub' && value.sourceSceneId === source.id && ['draft', 'rejected'].includes(value.status));
      if (existing) return json(res, 200, { ...existing, videoUrl: `/api/my/projects/${existing.id}/file` });
      const item = { id: randomUUID(), projectType: 'dub', title: `Озвучка — ${source.title}`.slice(0, 140), description: source.description || '', fileName: source.fileName, diskName: source.diskName, sourceVideoId: source.id, sourceSceneId: source.id, ownerId: user.id, ownerName: user.name, createdAt: new Date().toISOString(), status: 'draft', published: false, segments: (source.segments || []).map(segment => ({ id: randomUUID(), start: segment.start, end: segment.end, voiceOffset: 0, role: segment.role, text: segment.text })) };
      items.unshift(item); await saveCatalog(items);
      return json(res, 201, { ...item, videoUrl: `/api/my/projects/${item.id}/file` });
    }
    const privateFileMatch = pathname.match(/^\/api\/my\/projects\/([\w-]+)\/file$/);
    if (req.method === 'GET' && privateFileMatch) {
      const user = await requireUser(req, res); if (!user) return;
      const item = await getProject(privateFileMatch[1]);
      if (!item || !ownerCanAccess(item, user)) return json(res, 404, { error: 'Видео не найдено' });
      return sendMedia(req, res, path.join(uploadDir, item.diskName), mimeFor(item.diskName, 'video'));
    }
    const myProjectMatch = pathname.match(/^\/api\/my\/projects\/([\w-]+)$/);
    if (req.method === 'PUT' && myProjectMatch) {
      const user = await requireUser(req, res); if (!user) return;
      const body = await readJson(req);
      const items = await readCatalog(); const item = items.find(value => value.id === myProjectMatch[1]);
      if (!item || !ownerCanAccess(item, user)) return json(res, 404, { error: 'Проект не найден' });
      if (user.role !== 'admin' && !['draft', 'rejected'].includes(item.status)) return json(res, 409, { error: 'После отправки на проверку редактирование закрыто' });
      item.segments = normalizedSegments(Array.isArray(body.segments) ? body.segments : [], item.segments);
      await clearMix(item);
      await saveCatalog(items); return json(res, 200, item);
    }
    if (req.method === 'DELETE' && myProjectMatch) {
      const user = await requireUser(req, res); if (!user) return;
      const items = await readCatalog(); const item = items.find(value => value.id === myProjectMatch[1]);
      if (!item || item.ownerId !== user.id) return json(res, 404, { error: 'Проект не найден' });
      if (!['draft', 'rejected'].includes(item.status)) return json(res, 409, { error: 'Проект уже отправлен на проверку или опубликован' });
      const remaining = items.filter(value => value.id !== item.id);
      await removeUnusedProjectFiles(item, remaining); await saveCatalog(remaining);
      return json(res, 200, { ok: true });
    }
    const submitMatch = pathname.match(/^\/api\/my\/projects\/([\w-]+)\/submit$/);
    if (req.method === 'POST' && submitMatch) {
      const user = await requireUser(req, res); if (!user) return;
      const items = await readCatalog(); const item = items.find(value => value.id === submitMatch[1]);
      if (!item || item.ownerId !== user.id) return json(res, 404, { error: 'Проект не найден' });
      if (!['draft', 'rejected'].includes(item.status)) return json(res, 409, { error: 'Проект уже находится на проверке или опубликован' });
      if (!item.segments?.length) return json(res, 400, { error: 'Добавьте хотя бы одну реплику перед отправкой' });
      if (item.projectType === 'dub' && item.segments.some(segment => !segment.voiceFile)) return json(res, 400, { error: 'Запишите каждую реплику перед отправкой озвучки' });
      if (item.projectType === 'dub' && !item.mixFile) return json(res, 400, { error: 'Сначала соберите итоговую звуковую дорожку' });
      item.status = 'submitted'; item.submittedAt = new Date().toISOString(); item.published = false;
      await saveCatalog(items); return json(res, 200, item);
    }
    const voiceUploadMatch = pathname.match(/^\/api\/my\/projects\/([\w-]+)\/segments\/([\w-]+)\/audio$/);
    if (req.method === 'POST' && voiceUploadMatch) {
      const user = await requireUser(req, res); if (!user) return;
      const items = await readCatalog(); const item = items.find(value => value.id === voiceUploadMatch[1]);
      if (!item || !ownerCanAccess(item, user)) return json(res, 404, { error: 'Проект не найден' });
      if (user.role !== 'admin' && !['draft', 'rejected'].includes(item.status)) return json(res, 409, { error: 'Проект уже отправлен на проверку' });
      const segment = item.segments?.find(value => value.id === voiceUploadMatch[2]);
      if (!segment) return json(res, 404, { error: 'Сначала сохраните реплику' });
      const originalName = cleanFileName(url.searchParams.get('fileName') || 'voice.webm');
      const ext = fileSuffix(originalName, audioExtensions);
      if (!ext) return json(res, 415, { error: 'Поддерживаются MP3, WAV, OGG, M4A, AAC и WebM' });
      const voiceFile = `${randomUUID()}${ext}`;
      await receiveFile(req, path.join(uploadDir, voiceFile), maxAudioBytes);
      if (segment.voiceFile) await fs.rm(path.join(uploadDir, segment.voiceFile), { force: true });
      segment.voiceFile = voiceFile; segment.voiceName = originalName; segment.voiceMime = req.headers['content-type']?.split(';')[0] || mimeFor(ext, 'audio');
      await clearMix(item);
      await saveCatalog(items); return json(res, 201, { ok: true, voiceUrl: `/api/my/projects/${item.id}/segments/${segment.id}/audio` });
    }
    const privateAudioMatch = pathname.match(/^\/api\/my\/projects\/([\w-]+)\/segments\/([\w-]+)\/audio$/);
    if (req.method === 'GET' && privateAudioMatch) {
      const user = await requireUser(req, res); if (!user) return;
      const item = await getProject(privateAudioMatch[1]);
      const segment = item?.segments?.find(value => value.id === privateAudioMatch[2]);
      if (!item || !ownerCanAccess(item, user) || !segment?.voiceFile) return json(res, 404, { error: 'Запись не найдена' });
      return sendMedia(req, res, path.join(uploadDir, segment.voiceFile), segment.voiceMime || mimeFor(segment.voiceFile, 'audio'));
    }
    const mixMatch = pathname.match(/^\/api\/my\/projects\/([\w-]+)\/mix(?:down)?$/);
    if (req.method === 'POST' && mixMatch) {
      const user = await requireUser(req, res); if (!user) return;
      const items = await readCatalog(); const item = items.find(value => value.id === mixMatch[1]);
      if (!item || !ownerCanAccess(item, user) || item.projectType !== 'dub') return json(res, 404, { error: 'Озвучка не найдена' });
      if (user.role !== 'admin' && !['draft', 'rejected'].includes(item.status)) return json(res, 409, { error: 'Озвучка уже отправлена на проверку' });
      const mixFile = `${randomUUID()}.wav`;
      await receiveFile(req, path.join(uploadDir, mixFile), maxAudioBytes);
      await clearMix(item); item.mixFile = mixFile; item.mixMime = 'audio/wav'; item.mixName = `${cleanFileName(item.title)}.wav`; item.mixCreatedAt = new Date().toISOString();
      await saveCatalog(items); return json(res, 201, { ok: true, mixUrl: `/api/my/projects/${item.id}/mix`, mixName: item.mixName });
    }
    const privateMixMatch = pathname.match(/^\/api\/my\/projects\/([\w-]+)\/mix$/);
    if (req.method === 'GET' && privateMixMatch) {
      const user = await requireUser(req, res); if (!user) return;
      const item = await getProject(privateMixMatch[1]);
      if (!item || !ownerCanAccess(item, user) || !item.mixFile) return json(res, 404, { error: 'Итоговая дорожка ещё не собрана' });
      return sendMedia(req, res, path.join(uploadDir, item.mixFile), item.mixMime || 'audio/wav');
    }

    // Admin moderation and editorial workspace.
    if (req.method === 'GET' && pathname === '/api/admin/videos') {
      const user = await requireUser(req, res, 'admin'); if (!user) return;
      return json(res, 200, await readCatalog());
    }
    if (req.method === 'POST' && pathname === '/api/admin/videos') {
      const user = await requireUser(req, res, 'admin'); if (!user) return;
      const title = String(url.searchParams.get('title') || '').trim().slice(0, 140);
      const description = String(url.searchParams.get('description') || '').trim().slice(0, 1200);
      const originalName = cleanFileName(url.searchParams.get('fileName') || 'video.mp4');
      const ext = fileSuffix(originalName, videoExtensions);
      if (!title) return json(res, 400, { error: 'Добавьте название видео' });
      if (!ext) return json(res, 415, { error: 'Поддерживаются MP4, WebM, MOV и M4V' });
      const id = randomUUID(); const diskName = `${id}${ext}`;
      await receiveFile(req, path.join(uploadDir, diskName), maxVideoBytes);
      const item = { id, projectType: 'scene', title, description, fileName: originalName, diskName, ownerId: user.id, ownerName: user.name, createdAt: new Date().toISOString(), status: 'published', published: true, segments: [] };
      const items = await readCatalog(); items.unshift(item); await saveCatalog(items);
      return json(res, 201, { ...item, videoUrl: `/api/videos/${id}/file` });
    }
    const adminFileMatch = pathname.match(/^\/api\/admin\/videos\/([\w-]+)\/file$/);
    if (req.method === 'GET' && adminFileMatch) {
      const user = await requireUser(req, res, 'admin'); if (!user) return;
      const item = await getProject(adminFileMatch[1]); if (!item) return json(res, 404, { error: 'Видео не найдено' });
      return sendMedia(req, res, path.join(uploadDir, item.diskName), mimeFor(item.diskName, 'video'));
    }
    const adminAudioMatch = pathname.match(/^\/api\/admin\/videos\/([\w-]+)\/segments\/([\w-]+)\/audio$/);
    if (req.method === 'GET' && adminAudioMatch) {
      const user = await requireUser(req, res, 'admin'); if (!user) return;
      const item = await getProject(adminAudioMatch[1]); const segment = item?.segments?.find(value => value.id === adminAudioMatch[2]);
      if (!segment?.voiceFile) return json(res, 404, { error: 'Запись не найдена' });
      return sendMedia(req, res, path.join(uploadDir, segment.voiceFile), segment.voiceMime || mimeFor(segment.voiceFile, 'audio'));
    }
    const adminSegmentsMatch = pathname.match(/^\/api\/admin\/videos\/([\w-]+)\/segments$/);
    if (req.method === 'PUT' && adminSegmentsMatch) {
      const user = await requireUser(req, res, 'admin'); if (!user) return;
      const body = await readJson(req);
      if (!Array.isArray(body.segments)) return json(res, 400, { error: 'Ожидался список реплик' });
      const items = await readCatalog(); const item = items.find(value => value.id === adminSegmentsMatch[1]);
      if (!item) return json(res, 404, { error: 'Видео не найдено' });
      item.segments = normalizedSegments(body.segments, item.segments);
      if (item.projectType === 'dub') await clearMix(item);
      await saveCatalog(items);
      return json(res, 200, item);
    }
    const moderateMatch = pathname.match(/^\/api\/admin\/videos\/([\w-]+)\/(publish|reject)$/);
    if (req.method === 'POST' && moderateMatch) {
      const user = await requireUser(req, res, 'admin'); if (!user) return;
      const items = await readCatalog(); const item = items.find(value => value.id === moderateMatch[1]);
      if (!item) return json(res, 404, { error: 'Проект не найден' });
      item.status = moderateMatch[2] === 'publish' ? 'published' : 'rejected';
      item.published = moderateMatch[2] === 'publish';
      item.reviewedAt = new Date().toISOString();
      await saveCatalog(items); return json(res, 200, item);
    }
    const deleteMatch = pathname.match(/^\/api\/admin\/videos\/([\w-]+)$/);
    if (req.method === 'DELETE' && deleteMatch) {
      const user = await requireUser(req, res, 'admin'); if (!user) return;
      const items = await readCatalog(); const item = items.find(video => video.id === deleteMatch[1]);
      if (!item) return json(res, 404, { error: 'Видео не найдено' });
      const remaining = items.filter(video => video.id !== item.id);
      await removeUnusedProjectFiles(item, remaining); await saveCatalog(remaining); return json(res, 200, { ok: true });
    }

    // Friendly, explicit page routes.
    if (req.method === 'GET') {
      const user = await currentUser(req);
      if (pathname === '/admin') { res.writeHead(302, { Location: '/admin/' }); return res.end(); }
      if (pathname === '/admin/') {
        if (!user) { res.writeHead(302, { Location: '/login/?next=%2Fadmin%2F' }); return res.end(); }
        if (user.role !== 'admin') { res.writeHead(302, { Location: '/workspace/' }); return res.end(); }
      }
      if (pathname === '/workspace' || pathname === '/workspace/create' || pathname === '/workspace/segment' || pathname === '/workspace/dub') {
        res.writeHead(302, { Location: `${pathname}/` }); return res.end();
      }
      if (['/workspace/', '/workspace/create/', '/workspace/segment/', '/workspace/dub/'].includes(pathname) && !user) {
        res.writeHead(302, { Location: `/login/?next=${encodeURIComponent(pathname + url.search)}` }); return res.end();
      }
      const pages = { '/': 'index.html', '/admin/': 'admin.html', '/workspace/': 'workspace-home.html', '/workspace/create/': 'upload.html', '/workspace/segment/': 'workspace.html', '/workspace/dub/': 'dub.html', '/login/': 'login.html', '/register/': 'register.html' };
      const page = pages[pathname] || pathname.slice(1);
      const resolved = path.resolve(publicDir, page);
      if (!resolved.startsWith(`${publicDir}${path.sep}`)) return json(res, 403, { error: 'Запрещено' });
      try {
        const stat = await fs.stat(resolved);
        if (!stat.isFile()) return json(res, 404, { error: 'Не найдено' });
        res.writeHead(200, { 'Content-Type': mimeTypes[path.extname(resolved)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        return createReadStream(resolved).pipe(res);
      } catch { return json(res, 404, { error: 'Не найдено' }); }
    }
    return json(res, 404, { error: 'Маршрут не найден' });
  } catch (error) {
    const tooLarge = error.message?.includes('размер') || error.message?.includes('Слишком большой');
    if (!res.headersSent) return json(res, tooLarge ? 413 : 500, { error: error.message || 'Внутренняя ошибка сервера' });
    res.destroy();
  }
});

server.listen(port, host, () => console.log(`Реплика работает: http://localhost:${port}`));

import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const video = await readFile(path.join(root, 'test/fixtures/scene.webm'));
export function wav(seconds = .15) {
  const samples = Math.ceil(48000 * seconds), data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF', 0); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(48000, 24); data.writeUInt32LE(96000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin(i / 48000 * Math.PI * 880) * 3000), 44 + i * 2);
  return data;
}
export async function createTestDatabase() {
  if (!process.env.TEST_DATABASE_URL) throw new Error('Задайте TEST_DATABASE_URL. Тесты требуют PostgreSQL и право CREATEDB; DATABASE_URL приложения не используется.');
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const name = `replica_test_${randomUUID().replaceAll('-', '')}`;
  try { await admin.query(`CREATE DATABASE "${name}"`); }
  catch (error) { await admin.end(); throw error; }
  const url = new URL(process.env.TEST_DATABASE_URL); url.pathname = '/' + name;
  return { databaseUrl: url.toString(), async close() { try { await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`); } finally { await admin.end(); } } };
}
export async function startServer(directory, overrides = {}) {
  const dir = directory || await mkdtemp(path.join(tmpdir(), 'replica-test-'));
  const database = await createTestDatabase();
  let child, base, stderr = '';
  async function start() {
    child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, ...overrides, DATA_DIR: dir, DATABASE_URL: database.databaseUrl, HOST: '127.0.0.1', PORT: '0', NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr.on('data', chunk => { stderr += chunk; });
    base = await new Promise((resolve, reject) => { child.stdout.once('data', chunk => resolve(String(chunk).trim().split(' ').at(-1).replace('localhost', '127.0.0.1'))); child.once('error', reject); child.once('exit', code => reject(Error(`Server exited ${code}: ${stderr}`))); });
  }
  async function stop() { if (!child || child.exitCode !== null) return; const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; }
  try { await start(); } catch (error) { await database.close(); await rm(dir, { recursive: true, force: true }); throw error; }
  return {
    dir, databaseUrl: database.databaseUrl, get base() { return base; }, get stderr() { return stderr; },
    async restart() { await stop(); await start(); },
    async close() { await stop(); await database.close(); await rm(dir, { recursive: true, force: true }); },
    migrate() {
      return spawnSync(process.execPath, ['scripts/migrate-legacy.mjs', dir], { cwd: root, env: { ...process.env, DATA_DIR: dir, DATABASE_URL: database.databaseUrl }, encoding: 'utf8' });
    },
    promote(email) {
      const result = spawnSync(process.execPath, ['scripts/admin.mjs', email], { cwd: root, env: { ...process.env, DATA_DIR: dir, DATABASE_URL: database.databaseUrl }, encoding: 'utf8' });
      if (result.status) throw Error(result.stderr);
    },
    async api(url, { method = 'GET', body, cookie, headers = {} } = {}) {
      const isJson = body && typeof body === 'object' && !Buffer.isBuffer(body);
      const response = await fetch(base + url, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(isJson ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: isJson ? JSON.stringify(body) : body });
      const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
      return { status: response.status, data, headers: response.headers, cookie: response.headers.get('set-cookie')?.split(';')[0] };
    },
  };
}
export async function account(server, email, admin = false) {
  const result = await server.api('/api/auth/register', { method: 'POST', body: { name: 'Test Author', email, password: 'test-password' } });
  if (result.status !== 201) throw Error(JSON.stringify(result));
  if (admin) server.promote(email);
  return result;
}
export async function scene(server, cookie) {
  const uploaded = await server.api('/api/my/projects?title=Test%20scene&fileName=scene.webm', { method: 'POST', body: video, cookie });
  if (uploaded.status !== 201) throw Error(JSON.stringify(uploaded));
  const result = await server.api(`/api/my/projects/${uploaded.data.id}`, { method: 'PUT', cookie, body: { revision: uploaded.data.revision, segments: [{ id: 'one', start: .125, end: .9, text: 'One', role: 'Actor' }, { id: 'two', start: 1.1, end: 1.8, text: 'Two', role: 'Actor' }] } });
  if (result.status !== 200) throw Error(JSON.stringify(result));
  return result.data;
}

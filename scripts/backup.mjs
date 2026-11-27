import { spawn } from 'node:child_process';
import { createWriteStream, promises as fs } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { openStore } from '../lib/store.mjs';
import { projectFiles } from '../lib/takes.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const destination = process.argv[2] && path.resolve(process.argv[2]);
if (!destination || destination === source || destination.startsWith(source + path.sep)) throw new Error('Укажите новую папку резервной копии вне DATA_DIR');
const store = await openStore();
async function dump(snapshot, file) {
  const args = ['--format=custom', '--no-owner', '--no-privileges', `--snapshot=${snapshot}`];
  let command = process.env.PG_DUMP_PATH || 'pg_dump';
  const env = { ...process.env, PGDATABASE: process.env.DATABASE_URL };
  if (process.env.PG_DOCKER_SERVICE) {
    const url = new URL(process.env.DATABASE_URL);
    Object.assign(env, { PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password) });
    command = 'docker';
    args.unshift('compose', 'exec', '-T', '-e', 'PGDATABASE', '-e', 'PGUSER', '-e', 'PGPASSWORD', process.env.PG_DOCKER_SERVICE, 'pg_dump');
  }
  const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`pg_dump завершился с кодом ${code}: ${stderr}`))); });
  try { await Promise.all([pipeline(child.stdout, createWriteStream(file, { flags: 'wx' })), done]); }
  catch (error) { child.kill(); throw error; }
}
try {
  await fs.mkdir(destination); // Never overwrite a previous backup.
  await store.transaction(async tx => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot = (await tx.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot;
    const projects = await tx.projects();
    await dump(snapshot, path.join(destination, 'replica.dump'));
    await fs.mkdir(path.join(destination, 'uploads'));
    const files = new Set(projects.flatMap(projectFiles));
    for (const file of files) await fs.copyFile(path.join(source, 'uploads', file), path.join(destination, 'uploads', file));
  });
  await fs.writeFile(path.join(destination, 'COMPLETE'), new Date().toISOString());
  console.log(`Резервная копия: ${destination}`);
} catch (error) {
  console.error('Копия не завершена. Проверьте pg_dump; остановите приложение и повторите в новой папке.');
  throw error;
} finally { await store.close(); }

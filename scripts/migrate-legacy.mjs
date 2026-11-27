import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../lib/store.mjs';

const directory = path.resolve(process.argv[2] || process.env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '../data'));
const sqlitePath = path.join(directory, 'replica.sqlite');
let users, projects, sessions = [], source;
const sqliteExists = await fs.access(sqlitePath).then(() => true, () => false);
if (sqliteExists) {
  // SQLite is used only by this one-time, read-only importer, never by the app.
  const { DatabaseSync } = await import('node:sqlite');
  const legacy = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    legacy.exec('BEGIN');
    users = legacy.prepare('SELECT data FROM users').all().map(row => JSON.parse(row.data));
    projects = legacy.prepare('SELECT data FROM projects ORDER BY rowid').all().map(row => JSON.parse(row.data));
    sessions = legacy.prepare('SELECT token,user_id,expires FROM sessions WHERE expires>?').all(Date.now());
    legacy.exec('COMMIT'); source = 'sqlite';
  } finally { legacy.close(); }
} else {
  users = JSON.parse(await fs.readFile(path.join(directory, 'users.json'), 'utf8'));
  projects = JSON.parse(await fs.readFile(path.join(directory, 'catalog.json'), 'utf8')).reverse();
  source = 'json';
}
if (!Array.isArray(users) || !Array.isArray(projects)) throw new Error('Некорректные исходные данные');
const store = await openStore();
try {
  const result = await store.transaction(async tx => {
    await tx.query('LOCK TABLE users, projects, sessions, metadata IN ACCESS EXCLUSIVE MODE');
    if ((await tx.query("SELECT value FROM metadata WHERE key='legacy-data-import'")).rowCount) return 'Данные уже перенесены; повторный импорт не выполнялся.';
    const counts = (await tx.query('SELECT (SELECT count(*) FROM users) + (SELECT count(*) FROM projects) + (SELECT count(*) FROM sessions) AS total')).rows[0];
    if (Number(counts.total)) throw new Error('Импорт разрешён только в пустую базу PostgreSQL. Существующие данные не изменены.');
    for (const user of users) await tx.insertUser(user);
    for (const item of projects) await tx.putProject({ revision: 1, ...item });
    for (const session of sessions) await tx.addSession(session.token, session.user_id, Number(session.expires));
    await tx.query("INSERT INTO metadata (key,value) VALUES ('legacy-data-import',$1)", [JSON.stringify({ source, users: users.length, projects: projects.length, sessions: sessions.length, at: new Date().toISOString() })]);
    return `Перенесено: ${users.length} пользователей, ${projects.length} проектов, ${sessions.length} сессий. Медиа остаются в ${path.join(directory, 'uploads')}.`;
  });
  console.log(result);
} finally { await store.close(); }

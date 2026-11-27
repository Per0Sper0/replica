import pg from 'pg';
import { promises as fs } from 'node:fs';

export const fail = (status, message) => Object.assign(new Error(message), { status });

export async function openStore(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('Задайте DATABASE_URL для подключения к PostgreSQL');
  const pool = new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000 });
  pool.on('error', error => console.error('PostgreSQL connection error:', error.message));

  // Every transaction gets its own checked-out connection. Its facade cannot
  // accidentally send a query to another connection in the pool.
  function repository(connection, inTransaction = false) {
    const query = (sql, values) => connection.query(sql, values);
    const one = async (sql, values) => (await query(sql, values)).rows[0]?.data || null;
    return {
      query,
      user: id => one(`SELECT data FROM users WHERE id=$1${inTransaction ? ' FOR UPDATE' : ''}`, [id]),
      userByEmail: email => one(`SELECT data FROM users WHERE email=$1${inTransaction ? ' FOR UPDATE' : ''}`, [email]),
      users: async () => (await query('SELECT data FROM users ORDER BY id')).rows.map(row => row.data),
      async insertUser(user) {
        try { await query('INSERT INTO users (id,email,data) VALUES ($1,$2,$3)', [user.id, user.email, user]); }
        catch (error) { if (error.code === '23505') throw fail(409, 'Аккаунт с такой почтой уже существует'); throw error; }
      },
      saveUser: user => query('UPDATE users SET email=$2,data=$3 WHERE id=$1', [user.id, user.email, user]),
      getProject: id => one(`SELECT data FROM projects WHERE id=$1${inTransaction ? ' FOR UPDATE' : ''}`, [id]),
      projects: async () => (await query('SELECT data FROM projects ORDER BY sequence DESC')).rows.map(row => row.data),
      putProject: project => query(`INSERT INTO projects (id,data) VALUES ($1,$2)
        ON CONFLICT(id) DO UPDATE SET data=excluded.data`, [project.id, project]),
      deleteProject: id => query('DELETE FROM projects WHERE id=$1', [id]),
      async sessionUser(token) {
        return one('SELECT u.data FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=$1 AND s.expires>$2', [token, Date.now()]);
      },
      deleteSession: token => query('DELETE FROM sessions WHERE token=$1', [token]),
      addSession: (token, userId, expires) => query('INSERT INTO sessions (token,user_id,expires) VALUES ($1,$2,$3)', [token, userId, expires]),
      pruneSessions: () => query('DELETE FROM sessions WHERE expires<=$1', [Date.now()]),
    };
  }
  const store = repository(pool);
  store.transaction = async callback => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(repository(client, true));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  };
  store.mutate = (id, expectedRevision, change) => store.transaction(async tx => {
    const item = await tx.getProject(id);
    if (!item) throw fail(404, 'Проект не найден');
    if (!Number.isInteger(expectedRevision) || expectedRevision !== item.revision) throw fail(409, 'Проект изменён в другой вкладке. Обновите страницу перед сохранением.');
    await change(item, tx);
    item.revision++;
    item.updatedAt = new Date().toISOString();
    await tx.putProject(item);
    return item;
  });
  store.close = () => pool.end();
  try {
    await store.transaction(async tx => {
      // Serialize schema installation across processes, not ordinary requests.
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('replica-schema'))");
      await tx.query(await fs.readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8'));
    });
  } catch (error) { await pool.end(); throw error; }
  return store;
}

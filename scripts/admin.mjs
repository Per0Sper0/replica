import { openStore } from '../lib/store.mjs';

const email = process.argv[2]?.trim().toLowerCase();
if (!email) { console.error('Использование: npm run admin -- email@example.com (после регистрации)'); process.exit(1); }
const store = await openStore();
try {
  await store.transaction(async tx => {
    const user = await tx.userByEmail(email);
    if (!user) throw new Error('Сначала зарегистрируйте этот аккаунт');
    user.role = 'admin';
    await tx.saveUser(user);
  });
  console.log(`Администратор назначен: ${email}`);
} finally { await store.close(); }

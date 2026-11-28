const params = new URLSearchParams(location.search);
const next = params.get('next');
const safeNext = next && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') ? next : '';
const form = document.querySelector('#auth-form');
const message = document.querySelector('#auth-message');
if (safeNext) { const switchLink = document.querySelector('.auth-switch a'); switchLink.href = `${location.pathname.includes('register') ? '/login/' : '/register/'}?next=${encodeURIComponent(safeNext)}`; }
fetch('/api/auth/me').then(response => response.json()).then(({ user }) => { if (user) location.replace(safeNext || (user.role === 'admin' ? '/admin/' : '/workspace/')); }).catch(() => {});
form.addEventListener('submit', async event => {
  event.preventDefault();
  const registering = location.pathname.includes('register');
  const payload = { email: document.querySelector('#email').value.trim(), password: document.querySelector('#password').value };
  if (registering) payload.name = document.querySelector('#name').value.trim();
  const button = form.querySelector('button'); button.disabled = true; message.textContent = 'Подключаем…'; message.className = 'auth-message';
  try {
    const response = await fetch(`/api/auth/${registering ? 'register' : 'login'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Не удалось войти');
    const destination = safeNext || (registering && data.user.role === 'admin' ? '/admin/' : data.user.role === 'admin' ? '/admin/' : '/workspace/');
    location.assign(destination);
  } catch (error) { message.textContent = error.message; message.classList.add('error'); }
  finally { button.disabled = false; }
});

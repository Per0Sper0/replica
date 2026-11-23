async function request(url, options = {}) {
  const response = await fetch(url, options); const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Не удалось загрузить студию'); return data;
}
async function loadHome() {
  const { user } = await request('/api/auth/me');
  if (!user) { location.replace('/login/?next=%2Fworkspace%2F'); return; }
  document.querySelector('#workspace-name').textContent = user.name;
  document.querySelector('#workspace-role').textContent = user.role === 'admin' ? 'Администратор · автор' : 'Автор сообщества';
  document.querySelector('#welcome-title').innerHTML = `Привет, ${user.name.replace(/[&<>"']/g, '')}.<br><em>Выбирай режим.</em>`;
  if (user.role === 'admin') document.querySelector('#admin-link').classList.remove('hidden');
  const projects = await request('/api/my/projects');
  const scenes = projects.filter(project => project.projectType !== 'dub');
  const dubs = projects.filter(project => project.projectType === 'dub');
  document.querySelector('#scene-count').textContent = `${String(scenes.length).padStart(2, '0')} МОИХ СЦЕН`;
  document.querySelector('#dub-count').textContent = `${String(dubs.length).padStart(2, '0')} ОЗВУЧЕК`;
}
document.querySelector('#logout').addEventListener('click', async () => { await request('/api/auth/logout', { method: 'POST' }); location.assign('/'); });
loadHome().catch(() => { document.querySelector('#welcome-title').innerHTML = 'Не удалось открыть<br><em>студию.</em>'; });

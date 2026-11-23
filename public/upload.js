const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const statusLabel = status => ({ draft: 'Личный черновик', rejected: 'Нужны правки', submitted: 'На модерации', published: 'Опубликована' })[status] || 'Черновик';
async function request(url, options = {}) {
  const response = await fetch(url, options); const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Не удалось выполнить запрос'); return data;
}
async function loadUploadPage() {
  const { user } = await request('/api/auth/me');
  if (!user) { location.replace('/login/?next=%2Fworkspace%2Fcreate%2F'); return; }
  $('#workspace-name').textContent = user.name;
  $('#workspace-role').textContent = user.role === 'admin' ? 'Администратор · автор' : 'Автор сообщества';
  if (user.role === 'admin') $('#admin-link').classList.remove('hidden');
  const projects = (await request('/api/my/projects')).filter(project => project.projectType !== 'dub');
  $('#upload-project-count').textContent = `${String(projects.length).padStart(2, '0')} СЦЕН`;
  const host = $('#upload-project-list');
  if (!projects.length) { host.innerHTML = '<div class="empty-projects">Загрузи первое видео — оно появится здесь.</div>'; return; }
  host.innerHTML = projects.map(project => `<a class="project-row upload-project-row" href="/workspace/segment/?project=${encodeURIComponent(project.id)}"><span class="project-thumb">▤</span><span class="project-title"><b>${esc(project.title)}</b><small>${project.segments?.length || 0} реплик · ${esc(statusLabel(project.status))}</small></span><span class="project-published"><i></i>${esc(statusLabel(project.status))}</span><span class="upload-project-action">${['draft', 'rejected'].includes(project.status) ? 'Разметить' : 'Открыть'} <b>↗</b></span></a>`).join('');
}
$('#project-file').addEventListener('change', event => { $('#project-file-label').textContent = event.target.files[0]?.name || 'Выбери своё видео'; });
$('#project-form').addEventListener('submit', event => {
  event.preventDefault(); const file = $('#project-file').files[0]; if (!file) return;
  const button = event.currentTarget.querySelector('button[type="submit"]'); const progress = $('#project-progress'); const status = $('#project-upload-status');
  button.disabled = true; progress.classList.add('visible'); progress.firstElementChild.style.width = '0%';
  const query = new URLSearchParams({ title: $('#project-title').value.trim(), description: $('#project-description').value.trim(), fileName: file.name });
  const xhr = new XMLHttpRequest(); xhr.open('POST', `/api/my/projects?${query}`); xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
  xhr.upload.onprogress = event => { if (event.lengthComputable) { const percent = Math.round(event.loaded / event.total * 100); progress.firstElementChild.style.width = `${percent}%`; status.textContent = `Загрузка видео — ${percent}%`; } };
  xhr.onload = () => {
    let data = {}; try { data = JSON.parse(xhr.responseText); } catch {}
    if (xhr.status < 200 || xhr.status >= 300) { button.disabled = false; progress.classList.remove('visible'); status.textContent = data.error || 'Не удалось загрузить видео'; status.className = 'form-status error'; return; }
    status.textContent = 'Видео загружено. Открываю редактор реплик…'; status.className = 'form-status success';
    location.assign(`/workspace/segment/?project=${encodeURIComponent(data.id)}`);
  };
  xhr.onerror = () => { button.disabled = false; progress.classList.remove('visible'); status.textContent = 'Ошибка соединения с сервером'; status.className = 'form-status error'; };
  xhr.send(file);
});
$('#logout').addEventListener('click', async () => { await request('/api/auth/logout', { method: 'POST' }); location.assign('/'); });
loadUploadPage().catch(error => { $('#upload-project-list').innerHTML = `<div class="empty-projects">${esc(error.message)}. Войди или обнови страницу.</div>`; });

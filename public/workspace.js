const state = { user: null, projects: [], activeId: null, segments: [], dirty: false };
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const formatTime = value => { const seconds = Math.max(0, Math.floor(Number(value || 0))); return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; };
const parseTime = value => { const match = String(value || '').trim().match(/^(\d{2,}):([0-5]\d):([0-5]\d)$/); return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : NaN; };
const currentProject = () => state.projects.find(project => project.id === state.activeId);
const canEdit = () => ['draft', 'rejected'].includes(currentProject()?.status);
const sceneProjects = projects => projects.filter(project => project.projectType !== 'dub');
async function request(url, options = {}) { const response = await fetch(url, options); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || 'Не удалось выполнить запрос'); return data; }
function setStatus(node, message, kind = '') { node.textContent = message; node.className = `${node.className.split(' ')[0]} ${kind}`.trim(); }
function markDirty() { state.dirty = true; $('#submit-project').disabled = true; setStatus($('#project-save-status'), 'Есть несохранённые изменения', 'is-dirty'); }
function projectStatusLabel(project) { return ({ draft: 'Черновик', submitted: 'На проверке', published: 'Опубликована', rejected: 'Нужны правки' })[project.status] || 'Черновик'; }
function renderProjectList() {
  const host = $('#my-project-list'); $('#my-project-count').textContent = `${state.projects.length} СЦЕН`;
  if (!state.projects.length) { host.innerHTML = '<div class="empty-projects">Загрузи видео, чтобы создать первую сцену.</div>'; return; }
  host.innerHTML = state.projects.map(project => `<button class="project-row ${project.id === state.activeId ? 'selected' : ''}" data-id="${esc(project.id)}"><span class="project-thumb">▤</span><span class="project-title"><b>${esc(project.title)}</b><small>${project.segments?.length || 0} реплик · ${esc(projectStatusLabel(project))}</small></span><span class="project-published"><i></i> ${esc(projectStatusLabel(project))}</span><span class="project-chevron">›</span></button>`).join('');
  host.querySelectorAll('.project-row').forEach(row => row.addEventListener('click', () => changeProject(row.dataset.id)));
}
function renderTimeline() {
  const player = $('#project-video'); const track = $('#project-timeline');
  const duration = Number(player.duration) || Math.max(1, ...state.segments.map(segment => segment.end));
  track.querySelectorAll('.timeline-segment').forEach(element => element.remove());
  $('#project-duration').textContent = formatTime(duration);
  state.segments.forEach((segment, index) => {
    const left = Math.min(100, segment.start / duration * 100); const width = Math.max(.8, Math.min(100 - left, (segment.end - segment.start) / duration * 100));
    const bar = document.createElement('button'); bar.type = 'button'; bar.className = 'timeline-segment'; bar.style.left = `${left}%`; bar.style.width = `${width}%`; bar.title = `${formatTime(segment.start)} · ${segment.role || `Реплика ${index + 1}`}`; bar.innerHTML = `<span>${esc(segment.role || `Р${index + 1}`)}</span>`;
    bar.addEventListener('click', () => { player.pause(); player.currentTime = segment.start; }); track.append(bar);
  });
  updatePlayhead(duration);
}
function updatePlayhead(duration = null) {
  const player = $('#project-video'); const total = duration || Number(player.duration) || Math.max(1, ...state.segments.map(segment => segment.end));
  $('#project-playhead').style.left = `${Math.max(0, Math.min(100, (Number(player.currentTime) || 0) / total * 100))}%`;
}
function syncSegment(segment, element) {
  element.querySelector('[data-line-role]').addEventListener('input', event => { segment.role = event.target.value; markDirty(); });
  element.querySelector('[data-line-text]').addEventListener('input', event => { segment.text = event.target.value; markDirty(); });
  element.querySelectorAll('[data-line-time]').forEach(input => input.addEventListener('change', () => {
    const value = parseTime(input.value);
    if (!Number.isFinite(value)) { input.value = formatTime(segment[input.dataset.lineTime]); setStatus($('#project-save-status'), 'Используй формат 00:00:00', 'error'); return; }
    segment[input.dataset.lineTime] = value;
    if (segment.end <= segment.start) { setStatus($('#project-save-status'), 'Конец реплики должен быть позже начала', 'error'); segment[input.dataset.lineTime] = input.dataset.lineTime === 'start' ? segment.end - 1 : segment.start + 1; input.value = formatTime(segment[input.dataset.lineTime]); return; }
    state.segments.sort((a, b) => a.start - b.start); markDirty(); renderSegments();
  }));
  element.querySelector('.line-jump').addEventListener('click', () => { const player = $('#project-video'); player.pause(); player.currentTime = segment.start; });
  element.querySelector('.line-remove').addEventListener('click', () => { if (!canEdit()) return; state.segments = state.segments.filter(line => line.id !== segment.id); markDirty(); renderSegments(); });
}
function renderSegments() {
  const host = $('#workspace-segments'); const project = currentProject(); const locked = !canEdit();
  $('#project-line-count').textContent = `${state.segments.length} ${state.segments.length === 1 ? 'РЕПЛИКА' : 'РЕПЛИК'}`;
  $('#save-project').disabled = !project || locked; $('#submit-project').disabled = !project || locked || state.dirty || !state.segments.length; $('#project-add-line').disabled = !project || locked; $('#delete-my-project').disabled = !project || locked;
  if (!state.segments.length) { host.innerHTML = '<div class="empty-lines">Выбери участок ролика и добавь реплику</div>'; renderTimeline(); return; }
  host.innerHTML = state.segments.map((segment, index) => `<article class="workspace-line" data-id="${esc(segment.id)}"><div class="workspace-line-head"><button class="line-jump">${formatTime(segment.start)}</button><span class="scene-line-index">РЕПЛИКА ${String(index + 1).padStart(2, '0')}</span><button class="line-remove" aria-label="Удалить реплику" ${locked ? 'disabled' : ''}>×</button></div><div class="line-time-edit"><label>НАЧАЛО<input data-line-time="start" aria-label="Начало реплики ${index + 1}" value="${formatTime(segment.start)}" maxlength="8" ${locked ? 'disabled' : ''}></label><label>КОНЕЦ<input data-line-time="end" aria-label="Конец реплики ${index + 1}" value="${formatTime(segment.end)}" maxlength="8" ${locked ? 'disabled' : ''}></label></div><input class="line-role-input" data-line-role placeholder="Роль / персонаж" value="${esc(segment.role)}" ${locked ? 'disabled' : ''}><textarea class="line-text-input" data-line-text rows="2" placeholder="Текст реплики" ${locked ? 'disabled' : ''}>${esc(segment.text)}</textarea></article>`).join('');
  host.querySelectorAll('.workspace-line').forEach(element => syncSegment(state.segments.find(segment => segment.id === element.dataset.id), element));
  renderTimeline();
}
function selectProject(id) {
  const project = state.projects.find(item => item.id === id); state.activeId = project?.id || null;
  const player = $('#project-video'); player.pause(); player.removeAttribute('src'); player.load();
  $('#project-placeholder').classList.toggle('hidden', Boolean(project)); player.classList.toggle('hidden', !project);
  $('#project-active-title').textContent = project?.title || 'Сцена не выбрана';
  $('#project-active-description').textContent = project ? `${project.segments?.length || 0} размеченных реплик · ${projectStatusLabel(project)}` : 'Загрузи ролик или выбери свою сцену';
  if (project) player.src = project.videoUrl || `/api/my/projects/${project.id}/file`;
  state.segments = (project?.segments || []).map(segment => ({ ...segment })); state.dirty = false; $('#project-save-status').textContent = '';
  $('#delete-my-project').disabled = !project || !canEdit();
  const banner = $('#project-status-banner');
  if (project && project.status !== 'draft') { banner.textContent = project.status === 'submitted' ? 'Сцена отправлена на модерацию. После проверки она появится в каталоге и станет доступна для озвучки.' : project.status === 'rejected' ? 'Администратор запросил правки разметки. Исправь тайминги и отправь сцену снова.' : 'Сцена опубликована. Её можно выбрать в режиме озвучки.'; banner.classList.remove('hidden'); banner.dataset.status = project.status; }
  else banner.classList.add('hidden');
  $('#project-select').value = project?.id || ''; $('#project-role').value = ''; $('#project-text').value = ''; $('#project-start').value = ''; $('#project-end').value = '';
  renderSegments(); renderProjectList();
}
function changeProject(id) {
  if (state.dirty && !confirm('Есть несохранённые изменения. Переключиться без сохранения?')) { $('#project-select').value = state.activeId || ''; return; }
  selectProject(id);
}
async function loadProjects(preferredId) {
  const { user } = await request('/api/auth/me'); if (!user) { location.replace('/login/?next=%2Fworkspace%2Fsegment%2F'); return; }
  state.user = user; $('#workspace-name').textContent = user.name; $('#workspace-role').textContent = user.role === 'admin' ? 'Администратор · автор' : 'Автор сообщества';
  if (user.role === 'admin') $('#admin-link').classList.remove('hidden');
  const allProjects = await request('/api/my/projects'); state.projects = sceneProjects(allProjects);
  $('#project-select').innerHTML = state.projects.length ? state.projects.map(project => `<option value="${esc(project.id)}">${esc(project.title)} · ${esc(projectStatusLabel(project))}</option>`).join('') : '<option value="">Загрузи или выбери сцену</option>';
  let id = preferredId || new URLSearchParams(location.search).get('project') || (state.projects.some(project => project.id === state.activeId) ? state.activeId : state.projects[0]?.id);
  if (!state.projects.some(project => project.id === id)) id = null;
  selectProject(id || null);
}
async function saveSegments() {
  const project = currentProject(); if (!project) throw new Error('Сначала загрузи или выбери сцену');
  const body = { segments: state.segments.map(({ id, start, end, role, text }) => ({ id, start, end, role, text })) };
  const response = await request(`/api/my/projects/${project.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  project.segments = response.segments; state.segments = response.segments.map(segment => ({ ...segment })); state.dirty = false; renderSegments(); renderProjectList();
}
$('#project-select').addEventListener('change', event => changeProject(event.target.value));
document.querySelectorAll('[data-project-capture]').forEach(button => button.addEventListener('click', () => { if (currentProject()) $(`#project-${button.dataset.projectCapture}`).value = formatTime($('#project-video').currentTime); }));
$('#project-video').addEventListener('loadedmetadata', () => renderTimeline());
$('#project-video').addEventListener('timeupdate', () => {
  const player = $('#project-video'); updatePlayhead();
  const active = state.segments.find(segment => player.currentTime >= segment.start && player.currentTime < segment.end);
  $('#workspace-segments').querySelectorAll('.workspace-line').forEach(row => row.classList.toggle('is-active', row.dataset.id === active?.id));
});
$('#project-timeline').addEventListener('click', event => {
  if (event.target.closest('.timeline-segment')) return;
  const player = $('#project-video'); const rect = event.currentTarget.getBoundingClientRect(); const duration = Number(player.duration) || Math.max(1, ...state.segments.map(segment => segment.end));
  player.pause(); player.currentTime = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * duration;
});
$('#project-add-line').addEventListener('click', () => {
  const project = currentProject(); if (!project || !canEdit()) { setStatus($('#project-save-status'), 'Сначала выбери черновик сцены', 'error'); return; }
  const role = $('#project-role').value.trim(); const text = $('#project-text').value.trim(); const start = parseTime($('#project-start').value); const end = parseTime($('#project-end').value);
  if (!text) { $('#project-text').focus(); setStatus($('#project-save-status'), 'Добавь текст реплики', 'error'); return; }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) { $('#project-start').focus(); setStatus($('#project-save-status'), 'Введи начало и конец в формате 00:00:00', 'error'); return; }
  state.segments.push({ id: crypto.randomUUID(), role, text, start, end }); state.segments.sort((a, b) => a.start - b.start);
  $('#project-text').value = ''; $('#project-start').value = ''; $('#project-end').value = ''; markDirty(); renderSegments();
});
$('#save-project').addEventListener('click', async () => {
  const button = $('#save-project'); button.disabled = true;
  try { await saveSegments(); setStatus($('#project-save-status'), 'Разметка сохранена', 'is-saved'); }
  catch (error) { setStatus($('#project-save-status'), error.message, 'error'); }
  finally { renderSegments(); }
});
$('#submit-project').addEventListener('click', async () => {
  const project = currentProject(); if (!project || !canEdit()) return;
  if (state.dirty) { setStatus($('#project-save-status'), 'Сначала сохрани изменения в личный черновик', 'error'); return; }
  const button = $('#submit-project'); button.disabled = true;
  try {
    if (!state.segments.length) throw new Error('Сначала добавь хотя бы одну реплику');
    await request(`/api/my/projects/${project.id}/submit`, { method: 'POST' }); await loadProjects(project.id);
    setStatus($('#project-save-status'), 'Сохранённая сцена отправлена на модерацию');
  } catch (error) { setStatus($('#project-save-status'), error.message, 'error'); }
  finally { renderSegments(); }
});
$('#logout').addEventListener('click', async () => { await request('/api/auth/logout', { method: 'POST' }); location.assign('/'); });
$('#delete-my-project').addEventListener('click', async () => {
  const project = currentProject(); if (!project || !canEdit()) return;
  if (!confirm(`Удалить сцену «${project.title}» и её видео?`)) return;
  try { await request(`/api/my/projects/${project.id}`, { method: 'DELETE' }); state.projects = state.projects.filter(item => item.id !== project.id); state.activeId = null; await loadProjects(); setStatus($('#project-save-status'), 'Сцена удалена', 'is-saved'); }
  catch (error) { setStatus($('#project-save-status'), error.message, 'error'); }
});
loadProjects().catch(error => { $('#my-project-list').innerHTML = `<div class="empty-projects">${esc(error.message)}. Войди или обнови страницу.</div>`; });

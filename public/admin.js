const state = { videos: [], activeId: null, segments: [], dirty: false };
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const formatTime = ReplicaTime.format;
const parseTime = ReplicaTime.parse;
const selected = () => state.videos.find(video => video.id === state.activeId);
async function request(url, options = {}) { const response = await fetch(url, options); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || 'Не удалось выполнить запрос'); return data; }
function setStatus(node, message, kind = '') { node.textContent = message; node.className = `${node.className.split(' ')[0]} ${kind}`.trim(); }
function statusLabel(video) { return video.status === 'submitted' ? 'На проверке' : video.status === 'rejected' ? 'Нужны правки' : video.status === 'draft' ? 'Черновик' : 'Опубликовано'; }
async function moderate(id, action) {
  const item = state.videos.find(video => video.id === id);
  const comment = action === 'reject' ? prompt('Что автору нужно исправить?') : '';
  if (action === 'reject' && !comment?.trim()) return;
  await request(`/api/admin/videos/${id}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Project-Version': String(item.revision) }, body: JSON.stringify({ comment }) });
  await loadVideos();
}
function renderProjects() {
  $('#project-count').textContent = `${state.videos.length} ${state.videos.length === 1 ? 'СЦЕНА' : 'СЦЕН'}`;
  const list = $('#project-list');
  if (!state.videos.length) { list.innerHTML = '<div class="empty-projects">Загруженные видео появятся здесь.</div>'; return; }
  list.innerHTML = state.videos.map(video => `<button class="project-row ${video.id === state.activeId ? 'selected' : ''}" data-id="${esc(video.id)}"><span class="project-thumb">▶</span><span class="project-title"><b>${esc(video.title)}</b><small>${esc(video.ownerName || video.fileName)} · ${video.segments?.length || 0} реплик</small></span><span class="project-published"><i></i> ${statusLabel(video)}</span><span class="project-chevron">›</span></button>`).join('');
  list.querySelectorAll('.project-row').forEach(row => row.addEventListener('click', () => { if (!state.dirty || confirm('Переключиться без сохранения?')) selectVideo(row.dataset.id); }));
}
function renderReviews() {
  const submitted = state.videos.filter(video => video.status === 'submitted');
  $('#review-count').textContent = `${submitted.length} ${submitted.length === 1 ? 'ПРОЕКТ' : 'ПРОЕКТОВ'}`;
  $('#review-list').innerHTML = submitted.length ? submitted.map(video => `<article class="review-row"><div class="project-thumb">▶</div><div class="project-title"><b>${esc(video.title)}</b><small>От ${esc(video.ownerName || 'участника')} · ${video.segments?.length || 0} реплик</small></div><div class="review-actions"><button class="secondary-button review-open" data-id="${esc(video.id)}">Проверить</button><button class="secondary-button review-reject" data-id="${esc(video.id)}">Вернуть на правки</button><button class="primary-button review-publish" data-id="${esc(video.id)}">Опубликовать</button></div></article>`).join('') : '<div class="empty-projects">Новых сцен пока нет.</div>';
  $('#review-list').querySelectorAll('.review-open').forEach(button => button.addEventListener('click', () => { selectVideo(button.dataset.id); document.querySelector('.editor-section').scrollIntoView({ behavior: 'smooth' }); }));
  $('#review-list').querySelectorAll('.review-publish').forEach(button => button.addEventListener('click', async () => {
    try { await moderate(button.dataset.id, 'publish'); setStatus($('#upload-status'), 'Сцена опубликована в каталоге', 'success'); }
    catch (error) { setStatus($('#upload-status'), error.message, 'error'); }
  }));
  $('#review-list').querySelectorAll('.review-reject').forEach(button => button.addEventListener('click', async () => {
    try { await moderate(button.dataset.id, 'reject'); setStatus($('#upload-status'), 'Сцена возвращена автору в черновики', 'success'); }
    catch (error) { setStatus($('#upload-status'), error.message, 'error'); }
  }));
}
function renderTimeline() {
  const track = $('#timeline-track'); if (!track) return;
  track.querySelectorAll('.timeline-segment').forEach(el => el.remove());
  const duration = Number($('#admin-video').duration) || Math.max(1, ...state.segments.map(item => item.end));
  state.segments.forEach((segment, index) => {
    const block = document.createElement('button'); block.type = 'button'; block.className = 'timeline-segment';
    block.style.left = `${Math.max(0, segment.start / duration * 100)}%`;
    block.style.width = `${Math.max(.8, Math.min(100 - segment.start / duration * 100, (segment.end - segment.start) / duration * 100))}%`;
    block.title = `${formatTime(segment.start)} · ${segment.role || `Реплика ${index + 1}`}`;
    block.dataset.id = segment.id; block.innerHTML = `<span>${esc(segment.role || `Р${index + 1}`)}</span>`;
    block.addEventListener('click', () => { $('#admin-video').currentTime = segment.start; }); track.append(block);
  });
  const playhead = $('#playhead'); playhead.style.left = `${Math.min(100, (Number($('#admin-video').currentTime) || 0) / duration * 100)}%`;
  track.querySelectorAll('.timeline-segment').forEach(block => block.classList.toggle('is-active', block.dataset.id === state.activeSegmentId));
}
function renderSegments() {
  const host = $('#segment-list');
  const video = selected();
  $('#line-count').textContent = `${state.segments.length} ${state.segments.length === 1 ? 'РЕПЛИКА' : 'РЕПЛИК'}`;
  if (!state.segments.length) { host.innerHTML = '<div class="empty-lines">Добавь первую реплику с помощью формы справа</div>'; renderTimeline(); return; }
  host.innerHTML = state.segments.map((segment, index) => `<article class="editor-line" data-id="${esc(segment.id)}"><div class="editor-line-head"><button class="line-jump" type="button" aria-label="Перейти к началу реплики ${index + 1}">${formatTime(segment.start)}</button><button class="line-remove" type="button" aria-label="Удалить реплику">×</button></div><div class="editor-line-copy"><b>${esc(segment.role || `Реплика ${index + 1}`)}</b><p>${esc(segment.text)}</p><div class="line-time-edit"><label>НАЧАЛО<input aria-label="Начало реплики ${index + 1}" data-field="start" value="${formatTime(segment.start)}" maxlength="12"></label><label>КОНЕЦ<input aria-label="Конец реплики ${index + 1}" data-field="end" value="${formatTime(segment.end)}" maxlength="12"></label></div>${segment.voiceFile && video ? `<audio class="admin-review-audio" controls preload="none" src="/api/admin/videos/${video.id}/segments/${segment.id}/audio" aria-label="Озвучка: ${esc(segment.role || `Реплика ${index + 1}`)}"></audio>` : ''}</div></article>`).join('');
  host.querySelectorAll('.editor-line').forEach(line => {
    const segment = state.segments.find(value => value.id === line.dataset.id);
    line.querySelector('.line-jump').addEventListener('click', () => { $('#admin-video').currentTime = segment.start; });
    line.querySelector('.line-remove').addEventListener('click', () => { state.segments = state.segments.filter(value => value.id !== segment.id); markDirty(); renderSegments(); });
    line.querySelectorAll('[data-field]').forEach(input => input.addEventListener('change', () => {
      const value = parseTime(input.value); if (!Number.isFinite(value)) { input.value = formatTime(segment[input.dataset.field]); setStatus($('#save-status'), 'Время указывай в формате 00:00:00.000', 'error'); return; }
      if ((input.dataset.field === 'start' && value >= segment.end) || (input.dataset.field === 'end' && (value <= segment.start || value > selected().duration))) { input.value = formatTime(segment[input.dataset.field]); setStatus($('#save-status'), 'Реплика должна находиться внутри видео', 'error'); return; }
      segment[input.dataset.field] = value; state.segments.sort((a, b) => a.start - b.start); markDirty(); renderSegments();
    }));
  });
  renderTimeline();
}
function markDirty() { state.dirty = true; $('#save-status').textContent = 'Есть несохранённые изменения'; $('#save-status').className = 'save-status is-dirty'; }
function selectVideo(id) {
  state.activeId = id; const video = selected(); const player = $('#admin-video');
  player.pause(); player.removeAttribute('src'); player.load();
  $('#video-placeholder').classList.toggle('hidden', Boolean(video)); player.classList.toggle('hidden', !video); $('#delete-video').disabled = !video;
  $('#active-title').textContent = video?.title || 'Сцена не выбрана'; $('#active-description').textContent = video ? `${video.ownerName ? `Загрузил: ${video.ownerName} · ` : ''}${statusLabel(video)}` : 'Загрузи новое видео или выбери из списка';
  const review = Boolean(video); $('#moderation-panel').classList.toggle('hidden', !review); $('#reviewer-name').textContent = video?.ownerName || 'Автор';
  if (video) { player.src = `/api/admin/videos/${video.id}/file`; player.load(); }
  state.segments = (video?.segments || []).map(segment => ({ ...segment })); state.dirty = false; $('#save-status').textContent = '';
  $('#video-select').value = id || ''; renderSegments(); renderProjects();
  const locked = !video || !['draft', 'rejected'].includes(video.status);
  document.querySelectorAll('#segment-role, #segment-text, #segment-start, #segment-end, [data-capture]').forEach(control => { control.disabled = locked; });
  const editNotice = $('#admin-edit-notice'); editNotice.classList.toggle('hidden', !locked);
  editNotice.textContent = !video ? 'Сначала выбери сцену.' : `${video.status === 'published' ? 'Сцена опубликована.' : 'Сцена на модерации.'} Чтобы изменить реплики, нажми «Вернуть на правки» под видео.`;
  $('#save-segments').disabled = locked; $('#add-segment').disabled = locked;
  $('#publish-review').disabled = !video || !['draft', 'submitted'].includes(video.status);
  $('#return-review').disabled = !video;
  $('#segment-list').querySelectorAll('input, .line-remove').forEach(node => { node.disabled = locked; });
  const reviewPlayer = $('#review-mix'); reviewPlayer.classList.toggle('hidden', !video?.mixFile);
  reviewPlayer.src = video?.mixFile ? `/api/my/projects/${video.id}/mix` : '';
  $('#review-comment').textContent = video?.reviewComment || '';
}
async function loadVideos() {
  const { user } = await request('/api/auth/me');
  if (!user) { location.replace('/login/?next=%2Fadmin%2F'); return; }
  if (user.role !== 'admin') { location.replace('/workspace/'); return; }
  $('#admin-name').textContent = `${user.name} · администратор`;
  state.videos = await request('/api/admin/videos');
  $('#video-select').innerHTML = state.videos.length ? state.videos.map(video => `<option value="${esc(video.id)}">${esc(video.title)}</option>`).join('') : '<option value="">Сначала загрузите видео</option>';
  renderProjects(); renderReviews();
  const preferredId = state.activeId || new URLSearchParams(location.search).get('project');
  if (state.videos.length) selectVideo(state.videos.some(video => video.id === preferredId) ? preferredId : state.videos[0].id); else selectVideo(null);
}

$('#video-file').addEventListener('change', event => { $('#file-label').textContent = event.target.files[0]?.name || 'Перетащи видео или выбери файл'; });
$('#upload-form').addEventListener('submit', event => {
  event.preventDefault(); const file = $('#video-file').files[0]; if (!file) return;
  const status = $('#upload-status'), progress = $('#upload-progress'), button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true; progress.classList.add('visible'); progress.firstElementChild.style.width = '0%';
  const query = new URLSearchParams({ title: $('#video-title').value.trim(), description: $('#video-description').value.trim(), fileName: file.name });
  const xhr = new XMLHttpRequest(); xhr.open('POST', `/api/admin/videos?${query}`); xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
  xhr.upload.onprogress = event => { if (event.lengthComputable) { const value = Math.round(event.loaded / event.total * 100); progress.firstElementChild.style.width = `${value}%`; setStatus(status, `Загрузка — ${value}%`); } };
  xhr.onload = async () => { button.disabled = false; let data = {}; try { data = JSON.parse(xhr.responseText); } catch {}
    if (xhr.status < 200 || xhr.status >= 300) { progress.classList.remove('visible'); setStatus(status, data.error || 'Не удалось загрузить видео', 'error'); return; }
    setStatus(status, 'Видео сохранено в черновик. Разметь реплики, затем опубликуй сцену.', 'success'); $('#upload-form').reset(); $('#file-label').textContent = 'Перетащи видео или выбери файл';
    try { await loadVideos(); selectVideo(data.id); } catch (error) { setStatus(status, error.message, 'error'); } setTimeout(() => progress.classList.remove('visible'), 800);
  };
  xhr.onerror = () => { button.disabled = false; progress.classList.remove('visible'); setStatus(status, 'Ошибка соединения с сервером', 'error'); }; xhr.send(file);
});
$('#video-select').addEventListener('change', event => { if (state.dirty && !confirm('Есть несохранённые тайминги. Переключиться без сохранения?')) { event.target.value = state.activeId; return; } selectVideo(event.target.value); });
document.querySelectorAll('[data-capture]').forEach(button => button.addEventListener('click', () => { const player = $('#admin-video'); if (selected() && Number.isFinite(player.currentTime)) $(`#segment-${button.dataset.capture}`).value = formatTime(player.currentTime); }));
$('#admin-video').addEventListener('loadedmetadata', () => { $('#duration-label').textContent = formatTime($('#admin-video').duration); renderTimeline(); });
$('#admin-video').addEventListener('timeupdate', () => { renderTimeline(); const line = state.segments.find(segment => $('#admin-video').currentTime >= segment.start && $('#admin-video').currentTime <= segment.end); state.activeSegmentId = line?.id || null; $('#segment-list').querySelectorAll('.editor-line').forEach(row => row.classList.toggle('is-active', row.dataset.id === state.activeSegmentId)); });
$('#add-segment').addEventListener('click', () => {
  if (!selected() || !['draft', 'rejected'].includes(selected().status)) { $('#save-status').textContent = 'Сначала выбери видео'; return; }
  const role = $('#segment-role').value.trim(), text = $('#segment-text').value.trim(), start = parseTime($('#segment-start').value), end = parseTime($('#segment-end').value);
  if (!text) { $('#segment-text').focus(); $('#save-status').textContent = 'Добавь текст реплики'; return; }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > selected().duration) { $('#segment-start').focus(); setStatus($('#save-status'), 'Введи начало и конец в формате 00:00:00.000', 'error'); return; }
  state.segments.push({ id: crypto.randomUUID(), role, text, start, end }); state.segments.sort((a, b) => a.start - b.start); $('#segment-text').value = ''; $('#segment-start').value = ''; $('#segment-end').value = ''; markDirty(); renderSegments();
});
$('#save-segments').addEventListener('click', async () => {
  const video = selected(); if (!video) { $('#save-status').textContent = 'Сначала загрузи или выбери видео'; return; }
  const button = $('#save-segments'); button.disabled = true; setStatus($('#save-status'), 'Сохраняем…');
  try { const saved = await request(`/api/admin/videos/${video.id}/segments`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: video.revision, segments: state.segments.map(({ id, start, end, role, text }) => ({ id, start, end, role, text })) }) }); Object.assign(video, saved); state.dirty = false; renderSegments(); renderProjects(); setStatus($('#save-status'), 'Тайминги сохранены', 'is-saved'); }
  catch (error) { setStatus($('#save-status'), error.message, 'error'); } finally { button.disabled = false; }
});
$('#delete-video').addEventListener('click', async () => {
  const video = selected(); if (!video || !confirm(`Удалить «${video.title}» и все связанные файлы? Это действие нельзя отменить.`)) return;
  try { await request(`/api/admin/videos/${video.id}`, { method: 'DELETE' }); state.activeId = null; await loadVideos(); setStatus($('#upload-status'), 'Сцена удалена', 'success'); } catch (error) { setStatus($('#save-status'), error.message, 'error'); }
});
$('#publish-review').addEventListener('click', async () => {
  const video = selected(); if (!video) return;
  try { await moderate(video.id, 'publish'); setStatus($('#upload-status'), 'Видео опубликовано в каталоге', 'success'); }
  catch (error) { setStatus($('#save-status'), error.message, 'error'); }
});
$('#return-review').addEventListener('click', async () => {
  const video = selected(); if (!video) return;
  try { await moderate(video.id, 'reject'); setStatus($('#upload-status'), 'Видео возвращено автору на правки', 'success'); }
  catch (error) { setStatus($('#save-status'), error.message, 'error'); }
});
$('#logout').addEventListener('click', async () => { await request('/api/auth/logout', { method: 'POST' }); location.assign('/'); });
$('#admin-video').classList.add('hidden'); loadVideos().catch(error => { $('#project-list').innerHTML = `<div class="empty-projects">${esc(error.message)}. Войдите в аккаунт администратора.</div>`; });

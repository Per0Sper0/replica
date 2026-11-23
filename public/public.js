const grid = document.querySelector('#video-grid');
const count = document.querySelector('#catalog-count');
const dialog = document.querySelector('#player-dialog');
const dialogContent = document.querySelector('#dialog-content');
let currentUser = null;
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const clock = seconds => { const s = Math.max(0, Math.floor(seconds || 0)); return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

async function loadCatalog() {
  try {
    const response = await fetch('/api/videos');
    if (!response.ok) throw new Error('Не удалось загрузить каталог');
    const videos = await response.json();
    count.textContent = `${String(videos.length).padStart(2, '0')} ${videos.length === 1 ? 'СЦЕНА' : 'СЦЕН'}`;
    if (!videos.length) {
      grid.innerHTML = '<div class="catalog-empty"><span>✳</span><div><b>Здесь скоро появятся сцены</b><p>Редактор добавит первый фрагмент — и ему можно будет дать новый голос.</p></div></div>';
      return;
    }
    grid.innerHTML = videos.map((video, index) => `<article class="video-card" data-id="${esc(video.id)}"><button class="card-poster" type="button" aria-label="Открыть ${esc(video.title)}"><video src="${esc(video.videoUrl)}#t=0.1" preload="metadata" muted></video><span class="card-index">${String(index + 1).padStart(2, '0')}</span><span class="card-play">▶</span><span class="card-label">${video.segments?.length || 0} РЕПЛИК</span><span class="card-wave"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span></button><div class="card-copy"><div class="card-kicker">СЦЕНА ДЛЯ ОЗВУЧКИ <span>${new Date(video.createdAt).getFullYear()}</span></div><h3>${esc(video.title)}</h3><p>${esc(video.description || 'Найди характер и озвучь момент по-своему.')}</p><button class="card-action" type="button">Открыть сцену <span>↗</span></button></div></article>`).join('');
    grid.querySelectorAll('.video-card').forEach(card => {
      const video = videos.find(item => item.id === card.dataset.id);
      card.querySelectorAll('button').forEach(button => button.addEventListener('click', () => openVideo(video)));
      const posterVideo = card.querySelector('video');
      posterVideo.addEventListener('loadedmetadata', () => { if (posterVideo.videoWidth) posterVideo.currentTime = Math.min(.2, posterVideo.duration / 10); }, { once: true });
    });
  } catch {
    count.textContent = 'СЕРВЕР НЕДОСТУПЕН';
    grid.innerHTML = '<div class="catalog-empty"><span>!</span><div><b>Не получилось открыть каталог</b><p>Убедитесь, что сервер запущен, и обновите страницу.</p></div></div>';
  }
}

function openVideo(video) {
  const segments = [...(video.segments || [])].sort((a, b) => a.start - b.start);
  const next = `/workspace/dub/?source=${encodeURIComponent(video.id)}`;
  const dubAction = currentUser ? '<button class="primary-button dub-scene-button" id="dub-scene">Начать озвучку <span>↗</span></button>' : `<a class="primary-button dub-scene-button" href="/login/?next=${encodeURIComponent(next)}">Войти и озвучить <span>↗</span></a>`;
  dialogContent.innerHTML = `<div class="dialog-kicker">СЦЕНА ДЛЯ ОЗВУЧКИ <span>${segments.length} ${segments.length === 1 ? 'РЕПЛИКА' : 'РЕПЛИК'}</span></div><h2>${esc(video.title)}</h2><p class="dialog-description">${esc(video.description || 'Попробуй услышать эту сцену по-своему.')}</p><div class="dialog-player-wrap"><video id="public-player" controls playsinline src="${esc(video.videoUrl)}"></video><div class="active-caption" id="active-caption">Выбери реплику или нажми воспроизведение</div></div><div class="public-transcript">${segments.length ? segments.map((segment, i) => `<div class="public-line-wrap"><button class="public-line" data-start="${Number(segment.start)}" data-index="${i}"><span class="line-time">${clock(segment.start)}</span><span><b>${esc(segment.role || `Реплика ${i + 1}`)}</b><small>${esc(segment.text)}</small></span><span class="line-arrow">▶</span></button>${segment.audioUrl ? `<audio class="public-voice" controls preload="none" src="${esc(segment.audioUrl)}" aria-label="Озвучка: ${esc(segment.role || `Реплика ${i + 1}`)}"></audio>` : ''}</div>`).join('') : '<div class="empty-lines">Для этой сцены реплики пока не размечены.</div>'}</div><div class="dub-scene-callout"><div><b>Хочешь озвучить эту сцену?</b><small>Создадим личный черновик с готовыми репликами.</small></div>${dubAction}</div>`;
  dialog.showModal();
  const player = dialogContent.querySelector('#public-player');
  const caption = dialogContent.querySelector('#active-caption');
  const lines = [...dialogContent.querySelectorAll('.public-line')];
  lines.forEach(button => button.addEventListener('click', () => { player.currentTime = Number(button.dataset.start); player.play(); }));
  dialogContent.querySelector('#dub-scene')?.addEventListener('click', async event => {
    const button = event.currentTarget; button.disabled = true; button.textContent = 'Создаём черновик…';
    try { const response = await fetch(`/api/my/projects/from/${encodeURIComponent(video.id)}`, { method: 'POST' }); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Не удалось создать проект'); location.assign(`/workspace/dub/?project=${encodeURIComponent(data.id)}`); }
    catch (error) { button.disabled = false; button.textContent = error.message; }
  });
  player.addEventListener('timeupdate', () => {
    const active = segments.find(segment => player.currentTime >= segment.start && player.currentTime <= segment.end);
    caption.textContent = active ? `${active.role ? `${active.role}: ` : ''}${active.text}` : 'Выбери реплику или нажми воспроизведение';
    lines.forEach((line, i) => line.classList.toggle('is-active', segments[i] === active));
  });
}

document.querySelector('.dialog-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
dialog.addEventListener('close', () => { const player = dialogContent.querySelector('video'); if (player) player.pause(); });
fetch('/api/auth/me').then(response => response.json()).then(({ user }) => {
  currentUser = user;
  const link = document.querySelector('#account-link'); if (user) { link.href = '/workspace/'; link.innerHTML = 'Мои проекты <span aria-hidden="true">↗</span>'; }
  if (user?.role === 'admin') document.querySelector('#admin-nav').classList.remove('hidden');
}).catch(() => {});
loadCatalog();

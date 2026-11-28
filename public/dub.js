const state = { user: null, projects: [], catalog: [], project: null, segments: [], index: 0, recorder: null, stream: null, mode: null, countdownTimer: null, chunks: [], showMixStage: false, audioContext: null, analyser: null, videoSource: null, takePlayback: null, takePosition: 0, decodedTake: null, meterFrame: 0, waveformCache: new Map(), voiceDuration: new Map(), originalEnvelope: new Float32Array(720), lastEnvelopeDraw: 0, pendingTake: null, pendingUrl: null, micAnalyser: null, micSource: null, recordTimer: null, previewCleanup: null };
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const formatTime = ReplicaTime.format;
const shortTime = value => { const seconds = Math.max(0, Math.floor(Number(value || 0))); return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; };
const currentSegment = () => state.segments[state.index];
const hasVoice = segment => Boolean(segment?.voiceFile);
const canEdit = () => ['draft', 'rejected'].includes(state.project?.status);
const busy = () => Boolean(micCheck.opened || state.recorder || state.pendingTake || ['trimming', 'loading-take', 'requesting-mic', 'record-preview', 'countdown', 'saving', 'building', 'submitting'].includes(state.mode));
const micCheck = new ReplicaMicCheck($('#mic-check-dialog'), () => { if (state.project) renderStep(); });
const draftKey = () => `${state.user.id}:${state.project.id}`;
function adoptProject(project) {
  for (const segment of project.segments) {
    if (state.segments.find(s => s.id === segment.id)?.voiceFile !== segment.voiceFile) {
      state.waveformCache.delete(segment.id); state.voiceDuration.delete(segment.id);
    }
  }
  state.project = project; state.segments = project.segments;
  const index = state.projects.findIndex(item => item.id === project.id);
  if (index < 0) state.projects.unshift(project); else state.projects[index] = project;
}
function takeAudioUrl(projectId, segment, takeId = segment.selectedTakeId) {
  return `/api/my/projects/${projectId}/segments/${segment.id}/${takeId ? `takes/${encodeURIComponent(takeId)}/audio` : 'audio'}`;
}
function segmentEdits(segments) {
  return segments.map(({ id, start, end, text, role, voiceOffset, voiceTrimStart, voiceTrimEnd }) => ({ id, start, end, text, role, voiceOffset, voiceTrimStart, voiceTrimEnd }));
}
function renderTakeList() {
  const segment = currentSegment(), takes = segment?.takes || [];
  $('#take-list').classList.toggle('hidden', !takes.length);
  $('#take-list').innerHTML = takes.map((take, index) => {
    const selected = take.id === segment.selectedTakeId;
    const duration = Math.max(0, (take.voiceDuration || 0) - (take.voiceTrimStart || 0) - (take.voiceTrimEnd || 0));
    return `<div class="saved-take ${selected ? 'is-selected' : ''}"><div class="saved-take-info"><b>Дубль ${index + 1}</b><span>${duration.toFixed(3)} с${selected ? ' · Для сборки' : ''}</span></div><div class="saved-take-actions"><button type="button" class="text-button" data-listen-take="${esc(take.id)}" aria-label="Прослушать дубль ${index + 1}" ${busy() ? 'disabled' : ''}>Слушать</button><button type="button" class="secondary-button" data-select-take="${esc(take.id)}" aria-label="Выбрать дубль ${index + 1} для сборки" ${selected || !canEdit() || busy() ? 'disabled' : ''}>${selected ? 'Выбран' : 'Выбрать'}</button></div></div>`;
  }).join('');
}
function updateTakePlaybackButtons() {
  const playing = state.takePlayback?.takeId;
  const selectedPlaying = Boolean(state.takePlayback && playing === currentSegment()?.selectedTakeId);
  $('#play-take').textContent = selectedPlaying ? 'Ⅱ' : '▶'; $('#play-take').setAttribute('aria-label', selectedPlaying ? 'Пауза' : 'Прослушать дубль');
  $('#take-list').querySelectorAll('[data-listen-take]').forEach((button, index) => {
    const active = playing === button.dataset.listenTake;
    button.textContent = active ? 'Пауза' : 'Слушать'; button.setAttribute('aria-pressed', String(active));
    button.setAttribute('aria-label', active ? `Пауза: дубль ${index + 1}` : `Прослушать дубль ${index + 1}`);
  });
}
async function chooseTake(takeId) {
  if (busy() || !canEdit() || takeId === currentSegment()?.selectedTakeId) return;
  const segment = currentSegment(); state.mode = 'saving'; renderStep();
  try {
    adoptProject(await request(`/api/my/projects/${state.project.id}/segments/${segment.id}/takes/${encodeURIComponent(takeId)}/select`, { method: 'POST', headers: { 'X-Project-Version': String(state.project.revision) } }));
    await loadTakeWaveform(currentSegment());
    setStatus('Дубль выбран для сборки. Собери дорожку заново.', 'success');
  } catch (error) { setStatus(error.message, 'error'); }
  finally { state.mode = null; renderStep(); }
}
function releaseMicrophone() {
  clearTimeout(state.recordTimer); state.recordTimer = null;
  state.stream?.getTracks().forEach(track => track.stop()); state.stream = null;
  state.micSource?.disconnect(); state.micSource = null; state.micAnalyser = null;
  stopMeter();
}
function renderPendingTake() {
  const host = $('#pending-take'); host.classList.toggle('hidden', !state.pendingTake);
  if (!state.pendingTake) return;
  if (state.pendingUrl) URL.revokeObjectURL(state.pendingUrl);
  state.pendingUrl = URL.createObjectURL(state.pendingTake.file);
  $('#download-pending').href = state.pendingUrl; $('#download-pending').download = state.pendingTake.file.name || 'take.webm';
  $('#retry-take').disabled = state.mode === 'saving';
  $('#discard-take').disabled = state.mode === 'saving';
}
async function request(url, options = {}) { const response = await fetch(url, options); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || 'Не удалось выполнить запрос'); return data; }
function setStatus(message, kind = '') { const node = $('#dub-state'); node.textContent = message; node.className = `dub-state ${kind}`.trim(); }
function sceneDuration() { const videoLength = Number($('#line-video')?.duration); return Number.isFinite(videoLength) && videoLength > 0 ? videoLength : Math.max(1, ...state.segments.map(segment => Number(segment.end) || 0)); }
function getAudioContext() { const Context = window.AudioContext || window.webkitAudioContext; if (!state.audioContext && Context) state.audioContext = new Context(); return state.audioContext; }
function prepareAudioMeter() {
  const context = getAudioContext(); if (!context) return null;
  if (!state.analyser) { state.analyser = context.createAnalyser(); state.analyser.fftSize = 512; state.analyser.smoothingTimeConstant = .72; state.analyser.connect(context.destination); }
  if (!state.videoSource) { try { state.videoSource = context.createMediaElementSource($('#line-video')); state.videoSource.connect(state.analyser); } catch {} }
  return context;
}
function startMeter() {
  if (!prepareAudioMeter() || state.meterFrame) return;
  const values = new Float32Array(state.analyser.fftSize);
  const tick = timestamp => {
    state.meterFrame = 0;
    (state.micAnalyser || state.analyser).getFloatTimeDomainData(values);
    let total = 0; for (const sample of values) total += sample * sample;
    const rms = Math.sqrt(total / values.length); const db = rms > .00001 ? Math.max(-60, 20 * Math.log10(rms)) : -60;
    const level = Math.max(0, Math.min(100, (db + 60) / 60 * 100));
    $('#audio-meter-fill').style.width = `${level}%`; $('#audio-meter-value').textContent = db <= -59 ? '−∞ dB' : `${Math.round(db)} dB`;
    const video = $('#line-video');
    if (state.takePlayback) updatePlayhead(state.takePlayback.sceneStart + takePlaybackPosition());
    if (!video.paused && Number.isFinite(video.duration) && video.duration > 0) {
      const position = Math.min(state.originalEnvelope.length - 1, Math.floor(video.currentTime / video.duration * state.originalEnvelope.length));
      state.originalEnvelope[position] = Math.max(state.originalEnvelope[position], Math.min(1, rms * 3));
      if (timestamp - state.lastEnvelopeDraw > 100) { drawWaveform($('#original-waveform'), state.originalEnvelope); state.lastEnvelopeDraw = timestamp; }
    }
    if (state.recorder || !$('#line-video').paused || state.takePlayback) state.meterFrame = requestAnimationFrame(tick);
    else { $('#audio-meter-fill').style.width = '0%'; $('#audio-meter-value').textContent = '−∞ dB'; }
  };
  state.meterFrame = requestAnimationFrame(tick);
}
function stopMeter() { if (state.meterFrame) cancelAnimationFrame(state.meterFrame); state.meterFrame = 0; }
function updatePlayhead(time = Number($('#line-video').currentTime) || 0) {
  const percent = Math.max(0, Math.min(100, time / sceneDuration() * 100));
  document.querySelectorAll('.timeline-playhead').forEach(node => { node.style.left = `${percent}%`; });
}
function drawWaveform(canvas, samples = [], color = '#f2f2f2') {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect(); if (!rect.width || !rect.height) return;
  const ratio = Math.max(1, window.devicePixelRatio || 1); const width = Math.round(rect.width * ratio); const height = Math.round(rect.height * ratio);
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, width, height); ctx.fillStyle = color;
  const count = Math.min(samples.length || 1, Math.max(1, Math.floor(rect.width / 2.3)));
  const gap = ratio; const barWidth = Math.max(1, width / count - gap); const mid = height / 2;
  for (let i = 0; i < count; i++) {
    const sourceIndex = Math.floor(i / count * (samples.length || 1)); const amp = samples.length ? Number(samples[sourceIndex]) || 0 : 0;
    const bar = Math.max(ratio, amp * height * .88); ctx.globalAlpha = amp ? .9 : .16; ctx.fillRect(i / count * width, mid - bar / 2, barWidth, bar);
  }
  ctx.globalAlpha = 1;
}
function waveformFromBuffer(buffer) {
  const samples = buffer.getChannelData(0); const bars = Math.max(48, Math.min(640, Math.round(buffer.duration * 36))); const result = new Float32Array(bars); const stride = Math.max(1, Math.floor(samples.length / bars));
  let peak = 0;
  for (let i = 0; i < bars; i++) { let value = 0; const end = Math.min(samples.length, (i + 1) * stride); for (let j = i * stride; j < end; j++) value = Math.max(value, Math.abs(samples[j])); result[i] = value; peak = Math.max(peak, value); }
  return { samples: result, duration: buffer.duration, peakDb: peak > 0 ? Math.round(20 * Math.log10(peak)) : -60 };
}
function takeDuration(segment) {
  const duration = state.voiceDuration.get(segment.id) || segment.voiceDuration || 0;
  return Math.max(0, duration - (segment.voiceTrimStart || 0) - (segment.voiceTrimEnd || 0));
}
function takeWaveform(segment) {
  const wave = state.waveformCache.get(segment?.id);
  if (!wave) return [];
  const start = Math.floor((segment.voiceTrimStart || 0) / wave.duration * wave.samples.length);
  const end = Math.ceil((wave.duration - (segment.voiceTrimEnd || 0)) / wave.duration * wave.samples.length);
  return wave.samples.subarray(start, end);
}
function renderTakeSettings(resetInputs = true) {
  const segment = currentSegment(); if (!segment) return;
  const trimmed = Boolean(segment.voiceTrimStart || segment.voiceTrimEnd);
  $('#take-duration').textContent = `${takeDuration(segment).toFixed(3)} с`;
  $('#take-trim').classList.toggle('hidden', !hasVoice(segment));
  if (resetInputs) {
    $('#trim-start').value = segment.voiceTrimStart || 0;
    $('#trim-end').value = segment.voiceTrimEnd || 0;
  }
  for (const id of ['trim-start', 'trim-end', 'save-trim', 'auto-trim', 'reset-trim']) $('#' + id).disabled = !canEdit() || busy() || !hasVoice(segment);
  $('#reset-trim').disabled ||= !trimmed;
  $('#trim-summary').textContent = trimmed ? `После обрезки: ${takeDuration(segment).toFixed(3)} с. Изменения сохранены.` : 'Используется исходная запись.';
  const available = segment.end - segment.start - (segment.voiceOffset || 0);
  $('#take-fit-status').textContent = takeDuration(segment) > available + .05 ? 'Дубль выходит за конец реплики. Убери паузы, перезапиши его короче или подтверди обрезку при сборке.' : '';
}
async function decodedTake(segment, take = segment) {
  const key = `${state.project.id}:${take.voiceFile}`;
  if (state.decodedTake?.key === key) return state.decodedTake.buffer;
  const context = getAudioContext();
  if (!context) throw new Error('Этот браузер не поддерживает обработку звука.');
  const response = await fetch(takeAudioUrl(state.project.id, segment, take === segment ? segment.selectedTakeId : take.id));
  if (!response.ok) throw new Error('Не удалось загрузить дубль. Попробуй ещё раз.');
  const buffer = await context.decodeAudioData(await response.arrayBuffer());
  state.decodedTake = { key, buffer };
  if (take.voiceFile === segment.voiceFile) {
    state.voiceDuration.set(segment.id, buffer.duration); state.waveformCache.set(segment.id, waveformFromBuffer(buffer));
  }
  return buffer;
}
function takePlaybackPosition() {
  const playback = state.takePlayback;
  return playback ? Math.min(playback.duration, playback.position + state.audioContext.currentTime - playback.startedAt) : state.takePosition;
}
function stopTakePlayback(reset = true) {
  const playback = state.takePlayback;
  state.takePosition = reset ? 0 : takePlaybackPosition(); state.takePlayback = null;
  if (reset) state.previewTakeId = null;
  if (playback) playback.source.stop();
  updateTakePlaybackButtons();
  if ($('#line-video').paused && !state.recorder) stopMeter();
}
async function playTake(takeId = currentSegment()?.selectedTakeId) {
  if (busy() || !hasVoice(currentSegment())) return;
  if (state.takePlayback && state.takePlayback.takeId === takeId) { stopTakePlayback(false); return; }
  const segment = currentSegment(), take = segment.takes?.find(t => t.id === takeId) || segment;
  const position = state.previewTakeId === takeId ? state.takePosition : 0;
  state.mode = 'loading-take'; renderStep();
  try {
    const context = prepareAudioMeter(); await context?.resume();
    const buffer = await decodedTake(segment, take), range = ReplicaTrim.range(take, buffer.duration);
    const offset = position < range.duration ? position : 0;
    state.mode = null; renderStep();
    const startedAt = context.currentTime;
    const source = ReplicaTrim.schedule(context, state.analyser, buffer, { start: range.start + offset, end: range.end, duration: range.duration - offset }, startedAt);
    const playback = { source, position: offset, duration: range.duration, startedAt, takeId, sceneStart: segment.start + (take.voiceOffset || 0) };
    state.takePlayback = playback; state.previewTakeId = takeId;
    source.addEventListener('ended', () => {
      if (state.takePlayback !== playback) return;
      state.takePlayback = null; state.takePosition = 0;
      updateTakePlaybackButtons(); stopMeter(); updatePlayhead(playback.sceneStart);
    }, { once: true });
    updateTakePlaybackButtons(); startMeter();
  } catch (error) { state.mode = null; renderStep(); setStatus(error.message || 'Не получилось воспроизвести дубль.', 'error'); }
}
async function saveTrim(trim) {
  const segment = currentSegment();
  const segments = state.segments.map(item => item.id === segment.id ? { ...item, ...trim } : item);
  adoptProject(await request(`/api/my/projects/${state.project.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: state.project.revision, segments: segmentEdits(segments) }) }));
}
async function changeTrim(action) {
  if (busy() || !canEdit() || !hasVoice(currentSegment())) return;
  const trim = { voiceTrimStart: $('#trim-start').valueAsNumber, voiceTrimEnd: $('#trim-end').valueAsNumber };
  state.mode = 'trimming'; renderStep();
  try {
    if (action === 'auto') {
      setStatus('Ищу паузы по краям записи…');
      const detected = ReplicaTrim.detect(await decodedTake(currentSegment()));
      if (!detected) { setStatus('Не удалось уверенно найти голос. Запись не изменена; границы можно задать вручную.'); return; }
      if (!detected.voiceTrimStart && !detected.voiceTrimEnd) { setStatus('По краям записи нет тишины для обрезки. Текущие границы сохранены.'); return; }
      Object.assign(trim, detected);
    } else if (action === 'reset') { trim.voiceTrimStart = 0; trim.voiceTrimEnd = 0; }
    await saveTrim(trim);
    setStatus(action === 'reset' ? 'Исходная запись восстановлена. Собери дорожку заново.' : 'Обрезка сохранена. Прослушай начало и конец слов, затем собери дорожку заново.', 'success');
  } catch (error) { setStatus(error.message || 'Не удалось сохранить обрезку.', 'error'); }
  finally { state.mode = null; renderStep(); }
}
async function loadTakeWaveform(segment) {
  if (!hasVoice(segment) || state.waveformCache.has(segment.id)) return;
  const projectId = state.project.id;
  try {
    const context = getAudioContext(); if (!context) return;
    const response = await fetch(takeAudioUrl(projectId, segment)); if (!response.ok) return;
    const decoded = await context.decodeAudioData(await response.arrayBuffer());
    if (state.project?.id !== projectId || state.segments.find(s => s.id === segment.id)?.voiceFile !== segment.voiceFile) return;
    state.waveformCache.set(segment.id, waveformFromBuffer(decoded)); state.voiceDuration.set(segment.id, decoded.duration);
    if (currentSegment()?.id === segment.id) renderTakeSettings(false);
    renderTimeline();
  } catch { /* Keep the lane available if a browser cannot decode this take for its waveform. */ }
}
function renderTimeline() {
  if (!state.project || !state.segments.length) return;
  const duration = sceneDuration(); const durationLabel = $('#timeline-duration'); if (durationLabel) durationLabel.textContent = shortTime(duration);
  const ruler = $('#timeline-ruler'); if (ruler) ruler.innerHTML = Array.from({ length: 5 }, (_, i) => `<span>${esc(shortTime(duration * i / 4))}</span>`).join('');
  const stack = $('#voice-track'); if (!stack) return;
  stack.innerHTML = state.segments.map((segment, index) => {
    const start = Math.max(0, Number(segment.start) + (Number(segment.voiceOffset) || 0));
    const left = Math.max(0, Math.min(99.5, start / duration * 100));
    const takeLength = hasVoice(segment) ? takeDuration(segment) : Math.max(.8, Number(segment.end) - Number(segment.start));
    const width = Math.max(3, Math.min(100 - left, takeLength / duration * 100));
    const wave = state.waveformCache.get(segment.id); const label = segment.role || `Реплика ${index + 1}`;
    const peak = wave ? `${wave.peakDb} dB` : 'НЕТ ЗАПИСИ';
    return `<div class="audio-track-row voice-line-row ${index === state.index ? 'is-current' : ''}"><div class="track-label"><span class="track-icon voice-icon">${String(index + 1).padStart(2, '0')}</span><span><b>${esc(label)}</b><small>РЕПЛИКА ${String(index + 1).padStart(2, '0')} · ${esc(shortTime(segment.start))}</small></span></div><div class="track-lane voice-track-lane"><button class="track-clip ${hasVoice(segment) ? '' : 'is-empty'} ${index === state.index ? 'is-active' : ''}" type="button" data-track-index="${index}" style="left:${left}%;width:${width}%" aria-label="Реплика ${index + 1}, ${esc(label)}${hasVoice(segment) ? ', пик ' + peak : ', дубль не записан'}" title="${esc(label)} · ${esc(shortTime(segment.start))}${hasVoice(segment) ? ` · ${peak}` : ' · дубль не записан'}"><canvas aria-hidden="true"></canvas><span class="track-clip-label"><b>${String(index + 1).padStart(2, '0')}</b><small>${esc(label)}</small>${wave ? `<small>${wave.peakDb} dB</small>` : ''}</span></button><div class="timeline-playhead"></div></div></div>`;
  }).join('');
  $('#voice-track-status').textContent = `${state.segments.filter(hasVoice).length} ИЗ ${state.segments.length} ЗАПИСАНО`;
  requestAnimationFrame(() => {
    drawWaveform($('#original-waveform'), state.originalEnvelope);
    stack.querySelectorAll('.track-clip').forEach(button => drawWaveform(button.querySelector('canvas'), takeWaveform(state.segments[Number(button.dataset.trackIndex)])));
    updatePlayhead();
  });
}
function updateProgress() {
  const ready = state.segments.filter(hasVoice).length; const total = state.segments.length;
  $('#line-progress-count').textContent = `${ready} из ${total} готово`;
  $('#line-progress-bar').style.width = `${total ? ready / total * 100 : 0}%`;
}
function renderResumeDubs() {
  const host = $('#resume-dubs'); const dubs = state.projects.filter(project => project.projectType === 'dub');
  $('#resume-dubs-section').classList.toggle('hidden', !dubs.length);
  host.innerHTML = dubs.map(project => `<button class="picker-card" data-dub-id="${esc(project.id)}"><span class="picker-card-mark">◉</span><span class="picker-card-copy"><b>${esc(project.title)}</b><small>${project.segments?.filter(hasVoice).length || 0} из ${project.segments?.length || 0} реплик · ${esc(project.status === 'submitted' ? 'На модерации' : project.status === 'published' ? 'Опубликовано' : project.status === 'rejected' ? 'Нужны правки' : project.mixFile ? 'Дорожка собрана' : 'Черновик')}</small></span><span class="picker-card-arrow">↗</span></button>`).join('');
  host.querySelectorAll('[data-dub-id]').forEach(button => button.addEventListener('click', () => openDub(button.dataset.dubId)));
}
function sceneCard(scene, source) {
  return `<article class="picker-card scene-picker-card"><span class="picker-card-mark">${source === 'catalog' ? '✳' : '▤'}</span><span class="picker-card-copy"><b>${esc(scene.title)}</b><small>${scene.segments?.length || 0} реплик · ${esc(scene.description || (source === 'catalog' ? 'Сцена из каталога' : 'Твоя размеченная сцена'))}</small></span><button class="primary-button picker-start" data-source-id="${esc(scene.id)}">Озвучить <span>→</span></button></article>`;
}
function renderSceneChoices() {
  const catalogHost = $('#catalog-scenes'); const ownHost = $('#personal-scenes');
  const catalog = state.catalog.filter(scene => scene.projectType !== 'dub' && scene.segments?.length);
  const mine = state.projects.filter(project => project.projectType !== 'dub' && project.segments?.length);
  catalogHost.innerHTML = catalog.length ? catalog.map(scene => sceneCard(scene, 'catalog')).join('') : '<div class="catalog-empty"><span>✳</span><div><b>В каталоге пока нет сцен с разметкой</b><p>Ты можешь создать свою сцену в режиме подготовки.</p></div></div>';
  ownHost.innerHTML = mine.length ? mine.map(scene => sceneCard(scene, 'personal')).join('') : '<div class="catalog-empty"><span>▤</span><div><b>Своих сцен с репликами пока нет</b><p>Загрузи видео и добавь тайминги в редакторе создания сцены.</p></div></div>';
  document.querySelectorAll('[data-source-id]').forEach(button => button.addEventListener('click', async () => {
    button.disabled = true; button.textContent = 'Подготавливаем…';
    try { const project = await request(`/api/my/projects/from/${encodeURIComponent(button.dataset.sourceId)}`, { method: 'POST' }); await openDub(project.id); }
    catch (error) { button.disabled = false; button.textContent = error.message; }
  }));
}
async function openDub(id) {
  if (busy()) return;
  const project = (await request('/api/my/projects')).find(item => item.id === id);
  if (!project || project.projectType !== 'dub') throw new Error('Озвучка не найдена');
  stopTakePlayback(); adoptProject(project); state.segments = [...(project.segments || [])].sort((a, b) => a.start - b.start); state.index = Math.max(0, state.segments.findIndex(segment => !hasVoice(segment)));
  if (state.index === -1) state.index = Math.max(0, state.segments.length - 1);
  state.originalEnvelope = new Float32Array(720); state.waveformCache.clear(); state.voiceDuration.clear(); state.decodedTake = null;
  state.showMixStage = Boolean(project.mixFile && state.segments.length && state.segments.every(hasVoice));
  $('#scene-picker').classList.add('hidden'); $('#voice-booth').classList.remove('hidden');
  $('#booth-project-title').textContent = project.title; $('#line-video').pause(); $('#line-video').src = project.videoUrl || `/api/my/projects/${project.id}/file`; $('#line-video').load();
  history.replaceState({}, '', `/workspace/dub/?project=${encodeURIComponent(project.id)}`);
  state.pendingTake = await ReplicaDrafts.get(draftKey()).catch(() => null);
  renderStep(); renderPendingTake();
  if (state.pendingTake) setStatus('Найден несохранённый дубль. Повтори отправку или скачай запись.', 'error');
  else if (project.reviewComment && project.status === 'rejected') setStatus(`Нужны правки: ${project.reviewComment}`, 'error');
  state.segments.filter(hasVoice).forEach(segment => loadTakeWaveform(segment));
}
function showPicker() {
  if (busy()) { setStatus('Сначала останови запись дубля', 'error'); return; }
  if (state.mode === 'countdown') stopPreview('Запись отменена');
  $('#line-video').pause(); stopTakePlayback(); $('#mix-video').pause(); $('#mix-player').pause(); stopMeter(); state.mode = null; $('#voice-booth').classList.add('hidden'); $('#scene-picker').classList.remove('hidden');
  renderResumeDubs();
  history.replaceState({}, '', '/workspace/dub/');
}
function renderStep(autoplayOriginal = false) {
  const segment = currentSegment(); const total = state.segments.length; const video = $('#line-video');
  if (!segment || !state.project) return;
  $('#line-role').textContent = (segment.role || 'РЕПЛИКА').toLocaleUpperCase('ru');
  $('#line-number').textContent = String(state.index + 1).padStart(2, '0');
  $('#line-text').textContent = segment.text || 'Текст реплики не задан';
  $('#line-progress-label').textContent = `РЕПЛИКА ${String(state.index + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}`;
  $('#mini-clip-time').textContent = `${formatTime(segment.start)} — ${formatTime(segment.end)}`;
  $('#mini-clip-placeholder').classList.remove('hidden');
  $('#take-empty').classList.toggle('hidden', hasVoice(segment)); $('#take-preview-controls').classList.toggle('hidden', !hasVoice(segment));
  $('#retake-dub').classList.toggle('hidden', !hasVoice(segment) || !canEdit());
  $('#take-state').textContent = hasVoice(segment) ? 'ЗАПИСАНО' : 'ПОКА НЕТ';
  stopTakePlayback();
  $('#play-take').textContent = '▶'; $('#play-take').setAttribute('aria-label', 'Прослушать дубль');
  renderTakeSettings();
  renderTakeList();
  $('#voice-offset').value = segment.voiceOffset || 0;
  $('#voice-offset').disabled = !canEdit() || busy() || !hasVoice(segment);
  const navigationLocked = busy();
  $('#check-microphone').disabled = !canEdit() || navigationLocked;
  $('#record-dub').disabled = micCheck.opened || !canEdit() || Boolean(state.pendingTake) || ['trimming', 'loading-take', 'requesting-mic', 'saving', 'building', 'submitting'].includes(state.mode);
  $('#retake-dub').disabled = navigationLocked;
  $('#play-take').disabled = navigationLocked;
  $('#record-dub').textContent = state.mode === 'countdown' ? 'Начало через 1 сек…' : state.mode === 'record-preview' ? 'Отменить запись' : state.mode === 'recording' ? 'Остановить запись' : hasVoice(segment) ? 'Записать новый дубль' : 'Записать дубль';
  $('#record-dub').classList.toggle('recording', state.mode === 'recording');
  $('#previous-line').disabled = state.index <= 0 || navigationLocked;
  const next = $('#next-line'); next.disabled = !hasVoice(segment) || navigationLocked;
  next.textContent = state.index === total - 1 ? 'Перейти к сборке →' : 'Следующая реплика →';
  $('#play-original').disabled = navigationLocked;
  $('#restart-playback').disabled = navigationLocked;
  $('#back-to-picker').disabled = navigationLocked;
  $('#logout').disabled = navigationLocked;
  $('#mix-stage').classList.toggle('hidden', !state.showMixStage);
  $('#build-mix').disabled = !canEdit() || navigationLocked || !state.segments.every(hasVoice);
  $('#submit-dub').classList.toggle('hidden', !canEdit() || !state.project.mixFile);
  $('#submit-dub').disabled = navigationLocked;
  if (state.project.mixFile) showMixResult(); else { $('#mix-result').classList.add('hidden'); $('#mix-video').pause(); $('#mix-player').pause(); }
  updateProgress();
  $('#mix-video').pause(); $('#mix-player').pause();
  if (video.readyState >= 1) { video.pause(); video.currentTime = segment.start; $('#mini-clip-placeholder').classList.add('hidden'); if (autoplayOriginal) playOriginal(); }
  renderTimeline();
}
function stopPreview(message = '') {
  const video = $('#line-video'); video.pause();
  if (state.countdownTimer) { clearTimeout(state.countdownTimer); state.countdownTimer = null; }
  if (state.mode === 'record-preview' || state.mode === 'countdown') { state.mode = null; state.stream?.getTracks().forEach(track => track.stop()); state.stream = null; }
  else if (state.mode === 'original') state.mode = null;
  renderStep(); if (message) setStatus(message);
}
async function playOriginal() {
  if (!state.project || !currentSegment() || busy()) return;
  if (state.mode) { stopPreview('Прослушивание остановлено'); return; }
  const video = $('#line-video'); const segment = currentSegment(); stopTakePlayback();
  try { await prepareAudioMeter()?.resume(); } catch {}
  state.mode = 'original';
  video.pause(); video.currentTime = segment.start; $('#mini-clip-placeholder').classList.add('hidden');
  try { await video.play(); startMeter(); setStatus('Идёт оригинальная реплика. Видео остановится на её конце.'); }
  catch { state.mode = null; setStatus('Нажми «Послушать оригинал» ещё раз, чтобы запустить фрагмент.', 'error'); }
}
async function recordDub() {
  if (micCheck.opened || !state.project || !currentSegment() || !canEdit() || state.pendingTake || ['trimming', 'loading-take', 'saving', 'building', 'submitting', 'requesting-mic'].includes(state.mode)) return;
  if (state.recorder && state.recorder.state !== 'inactive') { state.recorder.stop(); return; }
  if (state.mode === 'record-preview' || state.mode === 'countdown') { stopPreview('Запись отменена'); renderStep(); return; }
  if (state.mode) stopPreview(); stopTakePlayback();
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { setStatus('В этом браузере запись с микрофона недоступна.', 'error'); return; }
  state.mode = 'requesting-mic'; renderStep(); setStatus('Запрашиваю доступ к микрофону…');
  try {
    await prepareAudioMeter()?.resume();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const video = $('#line-video'); const segment = currentSegment(); state.stream = stream; state.mode = 'record-preview';
    renderStep(); $('#record-dub').disabled = false; $('#record-dub').textContent = '■ Отменить';
    video.pause(); video.currentTime = segment.start; $('#mini-clip-placeholder').classList.add('hidden');
    await video.play(); setStatus('Слушай фразу. Когда она закончится, видео остановится и начнётся запись.');
  } catch (error) {
    state.stream?.getTracks().forEach(track => track.stop()); state.stream = null; state.mode = null; renderStep();
    setStatus(error.name === 'NotAllowedError' ? 'Разреши доступ к микрофону в браузере и попробуй снова.' : error.message || 'Не удалось начать запись.', 'error');
  }
}
function beginRecording() {
  const segment = currentSegment(); if (!segment || !state.stream) return;
  try {
    const options = MediaRecorder.isTypeSupported?.('audio/webm;codecs=opus') ? { mimeType: 'audio/webm;codecs=opus' } : undefined;
    const projectId = state.project.id; const revision = state.project.revision;
    const recorder = new MediaRecorder(state.stream, options); const captured = []; state.recorder = recorder; state.mode = 'recording';
    recorder.ondataavailable = event => { if (event.data.size) captured.push(event.data); };
    recorder.onerror = () => { if (recorder.state !== 'inactive') recorder.stop(); };
    recorder.onstop = async () => {
      const mime = recorder.mimeType || 'audio/webm'; const extension = mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'm4a' : 'webm';
      const lineId = segment.id; state.recorder = null; state.mode = 'saving'; releaseMicrophone();
      if (captured.length) {
        state.pendingTake = { projectId, segmentId: lineId, revision, takeId: crypto.randomUUID(), file: new File(captured, `re-plica-${lineId}.${extension}`, { type: mime }) };
        renderStep(); renderPendingTake();
        await ReplicaDrafts.put(draftKey(), state.pendingTake).catch(() => {});
        await saveVoice();
      }
      else { state.mode = null; renderStep(); setStatus('Запись пустая. Нажми «Записать дубль» и попробуй ещё раз.', 'error'); }
    };
    const context = getAudioContext(); state.micAnalyser = context.createAnalyser(); state.micAnalyser.fftSize = 512;
    state.micSource = context.createMediaStreamSource(state.stream); state.micSource.connect(state.micAnalyser);
    recorder.start(1000); state.recordTimer = setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, 900000);
    renderStep(); startMeter(); $('#record-dub').textContent = '■ Остановить запись'; $('#record-dub').classList.add('recording');
    setStatus('Идёт запись. Скажи фразу и нажми «Остановить запись».', 'recording');
  } catch (error) {
    state.recorder = null; state.mode = null; state.stream?.getTracks().forEach(track => track.stop()); state.stream = null; renderStep(); setStatus(error.message || 'Не удалось начать запись.', 'error');
  }
}
async function saveVoice() {
  const take = state.pendingTake; if (!take) return;
  state.mode = 'saving'; renderStep(); renderPendingTake();
  try {
    setStatus('Сохраняю дубль…');
    take.takeId ||= crypto.randomUUID(); await ReplicaDrafts.put(draftKey(), take).catch(() => {});
    const project = await request(`/api/my/projects/${take.projectId}/segments/${take.segmentId}/audio?${new URLSearchParams({ fileName: take.file.name, takeId: take.takeId })}`, { method: 'POST', headers: { 'Content-Type': take.file.type, 'X-Project-Version': String(take.revision) }, body: take.file });
    await ReplicaDrafts.remove(draftKey()).catch(() => {});
    state.pendingTake = null; adoptProject(project); state.waveformCache.delete(take.segmentId); state.voiceDuration.delete(take.segmentId);
    const segment = state.segments.find(item => item.id === take.segmentId); if (segment) await loadTakeWaveform(segment);
    setStatus('Дубль сохранён. Сравни варианты и выбери один для сборки.', 'success');
  } catch (error) { setStatus(`${error.message} Запись сохранена в этом браузере; её можно скачать или отправить повторно.`, 'error'); }
  finally { state.mode = null; renderStep(); renderPendingTake(); }
}
function navigateLine(direction) {
  if (busy()) return;
  if (direction > 0 && !hasVoice(currentSegment())) return;
  if (state.index === state.segments.length - 1 && direction > 0) { state.showMixStage = true; renderStep(); $('#mix-stage').scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
  state.index = Math.max(0, Math.min(state.segments.length - 1, state.index + direction)); state.mode = null; renderStep(true);
}
function showMixResult() {
  $('#mix-title').textContent = 'Дорожка готова';
  const url = `/api/my/projects/${state.project.id}/mix?v=${encodeURIComponent(state.project.mixCreatedAt || '')}`;
  $('#mix-player').src = url; $('#download-mix').href = url; $('#download-mix').download = state.project.mixName || `${state.project.title}.wav`;
  const preview = $('#mix-video');
  if (preview.dataset.mix !== url) {
    state.previewCleanup?.(); preview.src = `/api/my/projects/${state.project.id}/file`;
    $('#mix-video-audio').src = url;
    state.previewCleanup = ReplicaPlayback.connect(preview, $('#mix-video-audio'), message => setStatus(message, 'error'));
    preview.dataset.mix = url;
  }
  $('#mix-result').classList.remove('hidden');
  $('#submit-dub').classList.toggle('hidden', !canEdit());
  $('#submit-dub').disabled = busy();
}
function encodeWav(audioBuffer) {
  const samples = audioBuffer.getChannelData(0); const bytes = new ArrayBuffer(44 + samples.length * 2); const view = new DataView(bytes);
  const writeText = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  writeText(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); writeText(8, 'WAVE'); writeText(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, audioBuffer.sampleRate, true); view.setUint32(28, audioBuffer.sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); writeText(36, 'data'); view.setUint32(40, samples.length * 2, true);
  let peak = 0; for (const sample of samples) peak = Math.max(peak, Math.abs(sample)); const gain = peak > .98 ? .98 / peak : 1;
  for (let i = 0; i < samples.length; i++) { const value = Math.max(-1, Math.min(1, samples[i] * gain)); view.setInt16(44 + i * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true); }
  return new Blob([bytes], { type: 'audio/wav' });
}
async function buildMixdown() {
  if (busy() || !canEdit()) return;
  if (!state.project || !state.segments.length || !state.segments.every(hasVoice)) { setStatus('Сначала запиши каждую реплику.', 'error'); return; }
  state.mode = 'building'; renderStep();
  const projectId = state.project.id; const revision = state.project.revision;
  const button = $('#build-mix'); button.disabled = true; $('#mix-result').classList.add('hidden');
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  let decoder;
  try {
    if (!AudioContextClass || !window.OfflineAudioContext) throw new Error('Сборка дорожки не поддерживается этим браузером. Попробуй Chrome или Edge.');
    decoder = new AudioContextClass(); const decoded = [];
    for (let i = 0; i < state.segments.length; i++) {
      const segment = state.segments[i]; setStatus(`Загружаю и подготавливаю дубль ${i + 1} из ${state.segments.length}…`);
      const response = await fetch(takeAudioUrl(state.project.id, segment));
      if (!response.ok) throw new Error(`Не удалось получить запись реплики ${i + 1}`);
      const buffer = await decoder.decodeAudioData(await response.arrayBuffer()); decoded.push({ segment, buffer });
    }
    const duration = state.project.duration || sceneDuration();
    const tooLong = decoded.filter(({ segment, buffer }) => ReplicaTrim.range(segment, buffer.duration).duration > segment.end - segment.start - (segment.voiceOffset || 0) + .05);
    if (tooLong.length && !confirm(`${tooLong.length} записей выходят за конец своей реплики. Обрезать их по границам при сборке? Исходные дубли сохранятся.`)) return;
    if (!duration || duration > 15 * 60) throw new Error('Пока можно собрать дорожку длиной до 15 минут.');
    setStatus('Собираю единую дорожку по таймкодам…');
    const sampleRate = 48000; const mix = new OfflineAudioContext(1, Math.ceil(duration * sampleRate), sampleRate);
    decoded.forEach(({ segment, buffer }) => {
      const start = Math.max(0, segment.start + (Number(segment.voiceOffset) || 0));
      ReplicaTrim.schedule(mix, mix.destination, buffer, ReplicaTrim.range(segment, buffer.duration), start, segment.end - start);
    });
    const mixedBuffer = await mix.startRendering(); setStatus('Подготавливаю WAV-файл…'); const wav = encodeWav(mixedBuffer);
    if (wav.size > 96 * 1024 * 1024) throw new Error('Итоговый WAV больше лимита 96 МБ. Для этой сцены нужна более короткая разметка.');
    const project = await request(`/api/my/projects/${projectId}/mixdown`, { method: 'POST', headers: { 'Content-Type': 'audio/wav', 'X-Project-Version': String(revision) }, body: wav });
    adoptProject(project);
    $('#mix-title').textContent = 'Дорожка готова'; $('#mix-status').textContent = ''; showMixResult(); setStatus('Все реплики собраны в один WAV-файл.', 'success');
  } catch (error) { setStatus(error.message || 'Не удалось собрать дорожку.', 'error'); }
  finally { await decoder?.close?.(); state.mode = null; renderStep(); }
}
async function loadStudio() {
  const { user } = await request('/api/auth/me'); if (!user) { location.replace(`/login/?next=${encodeURIComponent(location.pathname + location.search)}`); return; }
  state.user = user; $('#workspace-name').textContent = user.name; $('#workspace-role').textContent = user.role === 'admin' ? 'Администратор · автор' : 'Автор сообщества';
  if (user.role === 'admin') $('#admin-link').classList.remove('hidden');
  const [projects, catalog] = await Promise.all([request('/api/my/projects'), request('/api/videos')]); state.projects = projects; state.catalog = catalog;
  renderResumeDubs(); renderSceneChoices();
  const params = new URLSearchParams(location.search);
  if (params.has('project')) { await openDub(params.get('project')); return; }
  if (params.has('source')) { const project = await request(`/api/my/projects/from/${encodeURIComponent(params.get('source'))}`, { method: 'POST' }); await openDub(project.id); }
}
$('#play-original').addEventListener('click', playOriginal);
$('#restart-playback').addEventListener('click', playOriginal);
$('#check-microphone').addEventListener('click', () => {
  if (busy() || !canEdit()) return;
  stopPreview(); micCheck.open();
});
$('#record-dub').addEventListener('click', recordDub);
$('#retake-dub').addEventListener('click', recordDub);
$('#previous-line').addEventListener('click', () => navigateLine(-1));
$('#next-line').addEventListener('click', () => navigateLine(1));
$('#back-to-picker').addEventListener('click', showPicker);
$('#play-take').addEventListener('click', () => playTake());
$('#take-list').addEventListener('click', event => {
  const listen = event.target.closest('[data-listen-take]'), select = event.target.closest('[data-select-take]');
  if (listen) playTake(listen.dataset.listenTake);
  else if (select) chooseTake(select.dataset.selectTake);
});
$('#take-trim').addEventListener('submit', event => { event.preventDefault(); changeTrim('manual'); });
$('#take-trim').addEventListener('input', () => { $('#trim-summary').textContent = 'Нажми «Сохранить обрезку», чтобы применить новые границы.'; });
$('#auto-trim').addEventListener('click', () => changeTrim('auto'));
$('#reset-trim').addEventListener('click', () => changeTrim('reset'));
$('#voice-track').addEventListener('click', async event => {
  if (busy()) return;
  const clip = event.target.closest('[data-track-index]'); if (!clip) return;
  const index = Number(clip.dataset.trackIndex); if (!Number.isInteger(index) || !state.segments[index]) return;
  state.mode = null; state.index = index; const segment = currentSegment(); renderStep();
  $('#line-video').pause(); $('#line-video').currentTime = segment.start;
  if (hasVoice(segment)) { if (!state.waveformCache.has(segment.id)) await loadTakeWaveform(segment); $('#play-take').click(); }
});
$('#original-track').addEventListener('click', event => {
  if (busy()) return;
  const rect = event.currentTarget.getBoundingClientRect(); if (!rect.width) return;
  const time = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * sceneDuration();
  const index = state.segments.findIndex(segment => time >= segment.start && time <= segment.end);
  if (index >= 0) { state.index = index; renderStep(); }
  $('#line-video').pause(); $('#line-video').currentTime = time; updatePlayhead(time);
});
$('#line-video').addEventListener('loadedmetadata', () => { $('#mini-clip-placeholder').classList.add('hidden'); const segment = currentSegment(); if (segment) $('#line-video').currentTime = segment.start; renderTimeline(); });
$('#line-video').addEventListener('timeupdate', () => {
  updatePlayhead($('#line-video').currentTime);
  const segment = currentSegment(); if (!segment || !state.mode || !['original', 'record-preview'].includes(state.mode)) return;
  if ($('#line-video').currentTime >= segment.end) {
    $('#line-video').pause(); $('#line-video').currentTime = segment.end;
    if (state.mode === 'record-preview') {
      state.mode = 'countdown'; renderStep(); setStatus('Оригинальная реплика закончилась. Запись начнётся через 1 секунду.', 'recording');
      state.countdownTimer = setTimeout(() => { state.countdownTimer = null; if (state.mode !== 'countdown') return; state.mode = 'recording'; renderStep(); beginRecording(); }, 1000);
    }
    else { state.mode = null; setStatus('Оригинальная фраза завершена. Можешь послушать ещё раз или записать дубль.'); }
  }
});
$('#line-video').addEventListener('play', startMeter);
$('#line-video').addEventListener('pause', () => { if (!state.takePlayback) stopMeter(); });
$('#line-video').addEventListener('error', () => { if (['record-preview', 'countdown'].includes(state.mode)) stopPreview(); if (state.project) setStatus('Не получилось открыть видео. Попробуй выбрать сцену ещё раз.', 'error'); });
window.addEventListener('resize', () => { drawWaveform($('#original-waveform'), state.originalEnvelope); $('#voice-track')?.querySelectorAll('.track-clip').forEach(button => drawWaveform(button.querySelector('canvas'), takeWaveform(state.segments[Number(button.dataset.trackIndex)]))); });
$('#build-mix').addEventListener('click', buildMixdown);
$('#submit-dub').addEventListener('click', async () => {
  if (busy()) return;
  state.mode = 'submitting'; renderStep();
  try {
    adoptProject(await request(`/api/my/projects/${state.project.id}/submit`, { method: 'POST', headers: { 'X-Project-Version': String(state.project.revision) } }));
    setStatus('Озвучка отправлена на модерацию.', 'success');
  } catch (error) { setStatus(error.message, 'error'); }
  finally { state.mode = null; renderStep(); }
});
$('#voice-offset').addEventListener('change', async event => {
  if (busy() || !canEdit()) return;
  const segment = currentSegment(); const value = Number(event.target.value);
  if (!Number.isFinite(value)) return;
  const segments = state.segments.map(item => item.id === segment.id ? { ...item, voiceOffset: value } : item);
  state.mode = 'saving'; renderStep();
  try { adoptProject(await request(`/api/my/projects/${state.project.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: state.project.revision, segments: segmentEdits(segments) }) })); setStatus('Сдвиг сохранён. Собери дорожку заново.'); }
  catch (error) { setStatus(error.message, 'error'); }
  finally { state.mode = null; renderStep(); }
});
$('#mix-video').addEventListener('play', () => { $('#mix-player').pause(); stopTakePlayback(); $('#line-video').pause(); });
$('#mix-player').addEventListener('play', () => { $('#mix-video').pause(); stopTakePlayback(); $('#line-video').pause(); });
$('#retry-take').addEventListener('click', saveVoice);
$('#discard-take').addEventListener('click', async () => {
  if (state.mode === 'saving' || !confirm('Удалить несохранённый дубль из этого браузера?')) return;
  await ReplicaDrafts.remove(draftKey()).catch(() => {}); state.pendingTake = null; renderPendingTake(); renderStep();
});
$('#logout').addEventListener('click', async () => {
  if (busy()) { setStatus('Сначала останови запись и сохрани дубль.', 'error'); return; }
  try { await request('/api/auth/logout', { method: 'POST' }); location.assign('/'); }
  catch (error) { setStatus(error.message, 'error'); }
});
window.addEventListener('beforeunload', event => { if (busy() && !micCheck.opened) { event.preventDefault(); event.returnValue = ''; } });
loadStudio().catch(error => { $('#catalog-scenes').innerHTML = `<div class="catalog-empty"><span>!</span><div><b>${esc(error.message)}</b><p>Войди в аккаунт или обнови страницу.</p></div></div>`; });

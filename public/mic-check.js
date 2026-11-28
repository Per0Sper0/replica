// A local, disposable recording. It never uses the project upload endpoint.
globalThis.ReplicaMicCheck = class {
  constructor(dialog, onChange) {
    this.dialog = dialog; this.onChange = onChange; this.opened = false;
    this.run = 0; this.phase = 'idle';
    this.find = selector => dialog.querySelector(selector);
    this.find('#mic-check-close').addEventListener('click', () => this.close());
    this.find('#mic-check-action').addEventListener('click', () => this.phase === 'recording' ? this.stop() : this.start());
    dialog.addEventListener('cancel', event => { event.preventDefault(); this.close(); });
    dialog.addEventListener('close', () => { if (this.opened && !dialog.open) this.close(); });
    window.addEventListener('pagehide', () => this.close());
    document.addEventListener('visibilitychange', () => { if (document.hidden && this.phase === 'recording') this.stop(); });
  }
  open() {
    if (this.opened) return;
    this.opened = true; this.dialog.showModal(); this.onChange(); this.start();
  }
  close() {
    if (!this.opened) return;
    this.opened = false; this.run++; this.release(); this.clearSample(); this.phase = 'idle';
    this.dialog.close(); this.onChange();
  }
  clearSample() {
    const player = this.find('#mic-check-player'); player.pause(); player.removeAttribute('src'); player.load();
    this.find('#mic-check-result').classList.add('hidden');
    if (this.sampleUrl) URL.revokeObjectURL(this.sampleUrl);
    this.sampleUrl = null;
  }
  release() {
    clearTimeout(this.timer); this.timer = null;
    cancelAnimationFrame(this.frame); this.frame = null;
    const recorder = this.recorder; this.recorder = null;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
    this.source?.disconnect(); this.source = null; this.analyser = null;
    this.context?.close().catch(() => {}); this.context = null;
    this.setLevel(-60);
  }
  render() {
    const button = this.find('#mic-check-action');
    button.disabled = ['requesting', 'processing'].includes(this.phase);
    button.textContent = this.phase === 'recording' ? 'Остановить пробу' : 'Записать ещё раз';
    this.dialog.dataset.phase = this.phase;
  }
  status(text) { this.find('#mic-check-status').textContent = text; }
  signal(text) {
    const node = this.find('#mic-check-signal');
    if (node.textContent !== text) node.textContent = text;
  }
  setLevel(db) {
    const label = db <= -60 ? '−∞ dB' : `${Math.round(db)} dB`;
    this.find('#mic-check-meter-fill').style.width = `${(db + 60) / 60 * 100}%`;
    this.find('#mic-check-level').textContent = label;
    const meter = this.find('#mic-check-meter'); meter.setAttribute('aria-valuenow', Math.round(db)); meter.setAttribute('aria-valuetext', label);
  }
  fail(message) {
    this.run++; this.release(); this.phase = 'error'; this.status(message); this.signal('Проба не записана.'); this.render();
  }
  async start() {
    if (!this.opened || ['requesting', 'recording', 'processing'].includes(this.phase)) return;
    const run = ++this.run;
    this.release(); this.clearSample(); this.phase = 'requesting';
    this.signal('Ожидаем микрофон.'); this.status('Разреши доступ к микрофону. Затем скажи короткую фразу.');
    this.find('#mic-check-device').textContent = 'Микрофон браузера'; this.render();
    try {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder || !Context) throw new Error('В этом браузере проверка микрофона недоступна.');
      const context = new Context(); this.context = context;
      await context.resume();
      if (run !== this.run || !this.opened) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Permission may be granted after the dialog was closed or reopened.
      if (run !== this.run || !this.opened) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      this.find('#mic-check-device').textContent = stream.getAudioTracks()[0]?.label || 'Микрофон браузера';
      this.analyser = context.createAnalyser(); this.analyser.fftSize = 2048;
      this.source = context.createMediaStreamSource(stream); this.source.connect(this.analyser);
      // The microphone is deliberately not connected to the speakers.
      const options = MediaRecorder.isTypeSupported?.('audio/webm;codecs=opus') ? { mimeType: 'audio/webm;codecs=opus' } : undefined;
      const recorder = new MediaRecorder(stream, options), chunks = [];
      this.recorder = recorder; this.signalFrames = 0; this.clippedFrames = 0;
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => { if (run === this.run) this.fail('Не удалось записать пробу. Попробуй ещё раз.'); };
      recorder.onstop = () => {
        if (run !== this.run || !this.opened) return;
        this.release();
        if (!chunks.length) { this.fail('Проба получилась пустой. Запиши фразу ещё раз.'); return; }
        this.sampleUrl = URL.createObjectURL(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
        this.find('#mic-check-player').src = this.sampleUrl; this.find('#mic-check-result').classList.remove('hidden');
        this.phase = 'ready'; this.status('Проба готова, микрофон отключён. Прослушай запись.');
        this.signal(this.clippedFrames >= 2 ? 'Сигнал перегружен. Уменьши громкость микрофона или отодвинься.' : this.signalFrames >= 3 ? 'Сигнал есть. Проверь на слух громкость и фоновый шум.' : 'Сигнал очень тихий или отсутствует. Подойди ближе и повтори пробу.');
        this.render();
      };
      stream.getAudioTracks().forEach(track => track.addEventListener('ended', () => {
        if (run === this.run && this.phase === 'recording') this.fail('Микрофон отключился. Подключи его и повтори пробу.');
      }, { once: true }));
      recorder.start(250); this.phase = 'recording'; this.startedAt = performance.now(); this.render();
      this.status('Идёт пробная запись. Скажи короткую фразу.');
      this.timer = setTimeout(() => this.stop(), 5000);
      const values = new Float32Array(this.analyser.fftSize);
      const tick = () => {
        if (run !== this.run || this.phase !== 'recording') return;
        this.analyser.getFloatTimeDomainData(values);
        let energy = 0, peak = 0;
        for (const value of values) { energy += value * value; peak = Math.max(peak, Math.abs(value)); }
        const rms = Math.sqrt(energy / values.length), db = Math.max(-60, Math.min(0, 20 * Math.log10(rms || 1e-6)));
        if (db > -50) this.signalFrames++;
        if (peak >= .98) this.clippedFrames++;
        this.setLevel(db);
        this.signal(peak >= .98 ? 'Слишком громко — отодвинься от микрофона.' : db > -50 ? 'Сигнал есть — продолжай говорить.' : 'Пока тихо — скажи несколько слов.');
        this.find('#mic-check-time').textContent = `${Math.max(0, Math.ceil(5 - (performance.now() - this.startedAt) / 1000))} с`;
        this.frame = requestAnimationFrame(tick);
      };
      tick();
    } catch (error) {
      if (run !== this.run || !this.opened) return;
      const messages = {
        NotAllowedError: 'Доступ к микрофону запрещён. Разреши его в настройках сайта и повтори пробу.',
        NotFoundError: 'Микрофон не найден. Подключи его и повтори пробу.',
        NotReadableError: 'Микрофон недоступен. Проверь, не занят ли он другим приложением.',
      };
      this.fail(messages[error.name] || error.message || 'Не удалось проверить микрофон.');
    }
  }
  stop() {
    if (this.phase !== 'recording') return;
    this.phase = 'processing'; this.status('Подготавливаю пробу…'); this.render(); this.release();
  }
};

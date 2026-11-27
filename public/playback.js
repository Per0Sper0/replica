window.ReplicaPlayback = {
  connect(video, audio, onError = () => {}) {
    const oldMuted = video.muted;
    video.muted = true;
    let active = true;
    const sync = () => { if (Number.isFinite(video.currentTime) && Math.abs(audio.currentTime - video.currentTime) > .15) audio.currentTime = video.currentTime; };
    const play = async () => {
      sync(); audio.playbackRate = video.playbackRate;
      try { await audio.play(); if (!active || video.paused) audio.pause(); }
      catch { if (active) { video.pause(); onError('Не удалось воспроизвести озвучку. Нажми воспроизведение ещё раз.'); } }
    };
    const pause = () => audio.pause();
    const rate = () => { audio.playbackRate = video.playbackRate; };
    const handlers = { play, playing: play, pause, waiting: pause, ended: pause, seeking: sync, timeupdate: sync, ratechange: rate };
    for (const [event, handler] of Object.entries(handlers)) video.addEventListener(event, handler);
    return () => { active = false; audio.pause(); video.muted = oldMuted; for (const [event, handler] of Object.entries(handlers)) video.removeEventListener(event, handler); };
  },
};

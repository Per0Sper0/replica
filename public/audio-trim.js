// Trim values are seconds removed from each edge of the original recording.
// No samples are overwritten; preview and mixdown use the same source range.
globalThis.ReplicaTrim = {
  range(segment, duration) {
    const start = Math.max(0, Number(segment.voiceTrimStart) || 0);
    const end = duration - Math.max(0, Number(segment.voiceTrimEnd) || 0);
    if (!Number.isFinite(duration) || start >= end) throw new Error('Обрезка не оставляет звука. Уменьши её или верни исходную запись.');
    return { start, end, duration: end - start };
  },
  detect(buffer) {
    // Conservative 10 ms RMS windows across all channels, with 80 ms handles
    // to protect quiet consonants. Internal pauses are always retained.
    const windowSize = Math.max(1, Math.round(buffer.sampleRate * .01));
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
    const thresholdSquared = 10 ** (-50 / 10);
    let first = -1, last = 0;
    for (let start = 0; start < buffer.length; start += windowSize) {
      const end = Math.min(buffer.length, start + windowSize);
      const active = channels.some(samples => {
        let energy = 0;
        for (let i = start; i < end; i++) energy += samples[i] ** 2;
        return energy / (end - start) >= thresholdSquared;
      });
      if (active) { if (first < 0) first = start; last = end; }
    }
    if (first < 0) return null;
    // Round toward retaining audio, never toward removing more samples.
    return {
      voiceTrimStart: Math.floor(Math.max(0, first / buffer.sampleRate - .08) * 1000) / 1000,
      voiceTrimEnd: Math.floor(Math.max(0, buffer.duration - last / buffer.sampleRate - .08) * 1000) / 1000,
    };
  },
  schedule(context, destination, buffer, range, when, limit = range.duration) {
    const duration = Math.min(range.duration, limit);
    if (!(duration > 0)) throw new Error('Для дубля не осталось места внутри реплики.');
    const source = context.createBufferSource(); source.buffer = buffer;
    const gain = context.createGain(); source.connect(gain); gain.connect(destination);
    const fade = Math.min(.005, duration / 2);
    if (range.start > 0) {
      gain.gain.setValueAtTime(0, when); gain.gain.linearRampToValueAtTime(1, when + fade);
    }
    if (range.end < buffer.duration || duration < range.duration) {
      gain.gain.setValueAtTime(1, when + duration - fade); gain.gain.linearRampToValueAtTime(0, when + duration);
    }
    source.onended = () => { source.disconnect(); gain.disconnect(); };
    source.start(when, range.start, duration);
    return source;
  },
};

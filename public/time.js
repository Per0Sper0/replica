window.ReplicaTime = {
  format(value) {
    const milliseconds = Math.max(0, Math.round((Number(value) || 0) * 1000));
    const seconds = Math.floor(milliseconds / 1000);
    return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`;
  },
  parse(value) {
    const match = String(value || '').trim().match(/^(\d{2,}):([0-5]\d):([0-5]\d)(?:[.,](\d{1,3}))?$/);
    return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number((match[4] || '').padEnd(3, '0')) / 1000 : NaN;
  },
};

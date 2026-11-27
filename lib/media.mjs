import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import ffprobe from '@ffprobe-installer/ffprobe';
import { fail } from './store.mjs';

const exec = promisify(execFile);
export function mediaMime(file, kind) {
  const ext = path.extname(file).toLowerCase();
  return ({ '.mp4': kind === 'audio' ? 'audio/mp4' : 'video/mp4', '.m4a': 'audio/mp4', '.mov': 'video/quicktime', '.m4v': 'video/mp4', '.webm': `${kind}/webm`, '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.aac': 'audio/aac' })[ext] || 'application/octet-stream';
}

export async function inspectMedia(file, kind) {
  const handle = await fs.open(file, 'r');
  const header = Buffer.alloc(64);
  try { await handle.read(header, 0, header.length, 0); } finally { await handle.close(); }
  const ext = path.extname(file).toLowerCase();
  const validSignature = ({
    '.wav': header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WAVE',
    '.webm': header.readUInt32BE(0) === 0x1a45dfa3,
    '.ogg': header.toString('ascii', 0, 4) === 'OggS',
    '.mp3': header.toString('ascii', 0, 3) === 'ID3' || (header[0] === 0xff && (header[1] & 0xe0) === 0xe0),
    '.aac': header[0] === 0xff && (header[1] & 0xf6) === 0xf0,
  })[ext] ?? (['.mp4', '.m4a', '.m4v', '.mov'].includes(ext) && ['ftyp', 'moov', 'mdat', 'wide'].includes(header.toString('ascii', 4, 8)));
  if (!validSignature) throw fail(415, 'Содержимое файла не соответствует выбранному формату медиа');
  const run = async entries => {
    try {
      const { stdout } = await exec(process.env.FFPROBE_PATH || ffprobe.path, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries', entries, '-of', 'json', file], { timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
      return JSON.parse(stdout);
    } catch { throw fail(415, 'Не удалось прочитать медиафайл. Проверьте формат и целостность файла.'); }
  };
  const info = await run('format=duration:stream=codec_type,codec_name,duration');
  if (!info.streams?.some(stream => stream.codec_type === kind && stream.codec_name) || (kind === 'audio' && info.streams.some(stream => stream.codec_type === 'video'))) throw fail(415, kind === 'video' ? 'Файл не содержит видеодорожки' : 'Нужен файл только со звуком');
  let duration = Math.max(Number(info.format?.duration) || 0, ...info.streams.map(stream => Number(stream.duration) || 0));
  // MediaRecorder WebM often has no duration in its container header.
  if (!duration) {
    const packets = await run('packet=pts_time,duration_time');
    duration = (packets.packets || []).reduce((end, packet) => Math.max(end, (Number(packet.pts_time) || 0) + (Number(packet.duration_time) || 0)), 0);
  }
  if (!Number.isFinite(duration) || duration <= 0 || duration > 900.1) throw fail(422, 'Длительность медиа должна быть больше нуля и не более 15 минут');
  return { duration, bytes: (await fs.stat(file)).size, mime: mediaMime(file, kind) };
}

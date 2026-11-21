import fs from 'node:fs';
import path from 'node:path';
const GALLERY_MEDIA = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.m4v': 'video/mp4',
};
const VIDEO = new Set(['.mp4', '.mov']);

function mediaIdentity(info) {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}

export function assertStableMedia(file, expectedIdentity) {
  const logical = path.resolve(String(file || ''));
  const logicalInfo = fs.lstatSync(logical);
  if (logicalInfo.isSymbolicLink()) throw new Error('媒体路径不能是符号链接。');
  const resolved = fs.realpathSync.native(logical);
  const info = fs.lstatSync(resolved);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('媒体路径不是普通文件。');
  if (expectedIdentity && mediaIdentity(info) !== expectedIdentity) {
    throw new Error('媒体文件在应用前发生变化。');
  }
  return { path: resolved, identity: mediaIdentity(info) };
}

export async function validateLocalMedia(file, core) {
  const logical = path.resolve(String(file || ''));
  const ext = path.extname(logical).toLowerCase();
  if (!GALLERY_MEDIA[ext]) throw new Error('不支持的媒体格式。');
  const first = assertStableMedia(logical);
  const checked = VIDEO.has(ext)
    ? await core.validateVideoFile(first.path, { mode: 'fast' })
    : await core.validateImageFile(first.path, { mode: 'fast' });
  const stable = assertStableMedia(checked.filePath, first.identity);
  return { path: stable.path, identity: stable.identity };
}


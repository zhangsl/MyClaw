import { basename, extname } from 'node:path';

export const MAX_MEDIA_BYTES = 30 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const mimeTypes: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.heic': 'image/heic',
  '.opus': 'audio/ogg', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
  '.csv': 'text/csv', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp4': 'video/mp4', '.zip': 'application/zip',
};

export function mimeTypeForFile(path: string): string {
  return mimeTypes[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

export function safeFileName(name: string | undefined, fallback: string): string {
  const cleaned = basename(name ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 180);
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : fallback;
}

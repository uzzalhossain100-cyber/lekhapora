const BLOCKED_HOSTS = new Set(['localhost', 'metadata.google.internal', 'metadata.google.com']);

function isPrivateIp(host) {
  const match = String(host).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part > 255)) return true;
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0 || a === 255) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isAllowedBookUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch (_) { return false; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/\.+$/, '');
  if (!host || BLOCKED_HOSTS.has(host) || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) return false;
  if (host.includes(':') || isPrivateIp(host)) return false;
  return true;
}

function driveFileId(value) {
  const url = String(value || '');
  const file = url.match(/drive\.google\.com\/file\/d\/([^/?#]+)/);
  if (file) return file[1];
  const id = url.match(/[?&]id=([^&#]+)/);
  if (id && /google\.com|googleusercontent\.com/.test(url)) return id[1];
  return '';
}

function previewFromLink(link) {
  const id = driveFileId(link);
  if (id) return `https://drive.google.com/file/d/${id}/preview`;
  return String(link || '');
}

module.exports = { isAllowedBookUrl, driveFileId, previewFromLink };

export type MediaSource = 'youtube' | 'youtube_music';

export const MEDIA_SOURCE_URL_PATTERNS: Record<MediaSource, string> = {
  youtube: 'https://www.youtube.com/*',
  youtube_music: 'https://music.youtube.com/*',
};

export function isMediaSource(value: unknown): value is MediaSource {
  return value === 'youtube' || value === 'youtube_music';
}

export function sourceFromHostname(hostname: string): MediaSource | undefined {
  if (hostname === 'www.youtube.com') return 'youtube';
  if (hostname === 'music.youtube.com') return 'youtube_music';
  return undefined;
}

export function sourceFromUrl(url: string | undefined): MediaSource | undefined {
  if (!url) return undefined;
  try { return sourceFromHostname(new URL(url).hostname); } catch { return undefined; }
}

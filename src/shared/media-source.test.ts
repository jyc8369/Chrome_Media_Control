import {describe,expect,it} from 'vitest';
import {MEDIA_SOURCE_URL_PATTERNS,sourceFromHostname,sourceFromUrl} from './media-source';
import {isCommand} from './protocol';

describe('media sources',()=>{
  it('maps only the supported YouTube domains',()=>{
    expect(sourceFromHostname('www.youtube.com')).toBe('youtube');
    expect(sourceFromHostname('music.youtube.com')).toBe('youtube_music');
    expect(sourceFromUrl('https://www.youtube.com/watch?v=abc')).toBe('youtube');
    expect(sourceFromUrl('https://music.youtube.com/watch?v=abc')).toBe('youtube_music');
    expect(sourceFromUrl('https://m.youtube.com/watch?v=abc')).toBeUndefined();
    expect(MEDIA_SOURCE_URL_PATTERNS.youtube_music).toBe('https://music.youtube.com/*');
  });
  it('accepts commands only when a valid target source is supplied',()=>{
    expect(isCommand({protocolVersion:1,type:'command',timestamp:1,requestId:'id',source:'youtube',command:'toggle'})).toBe(true);
    expect(isCommand({protocolVersion:1,type:'command',timestamp:1,requestId:'id',source:'other',command:'toggle'})).toBe(false);
  });
});

import {describe,expect,it} from 'vitest';
import {MediaTabSelector,type MediaTabSession} from './media-tab-selector';

function session(overrides:Partial<MediaTabSession>&Pick<MediaTabSession,'tabId'|'source'>):MediaTabSession {
  return {
    playing:false,
    lastAccessed:0,
    updatedAt:0,
    ...overrides,
  };
}

describe('MediaTabSelector',()=>{
  it('keeps the explicitly selected tab when another tab sends a heartbeat',()=>{
    const selector=new MediaTabSelector();
    selector.upsert(session({tabId:1,source:'youtube',lastAccessed:10}));
    selector.upsert(session({tabId:2,source:'youtube',lastAccessed:20}));
    expect(selector.select('youtube',1)).toBe(true);

    selector.upsert(session({tabId:2,source:'youtube',playing:true,lastAccessed:30,updatedAt:100}));

    expect(selector.selectedTabId('youtube')).toBe(1);
    expect(selector.isSelected('youtube',2)).toBe(false);
  });

  it('uses focused, playing, recent, and tab id fallback priority',()=>{
    const selector=new MediaTabSelector();
    selector.upsert(session({tabId:8,source:'youtube',lastAccessed:100}));
    selector.upsert(session({tabId:4,source:'youtube',playing:true,lastAccessed:50}));
    selector.upsert(session({tabId:2,source:'youtube',playing:true,lastAccessed:50}));

    expect(selector.chooseFallback('youtube',8)).toBe(8);
    expect(selector.chooseFallback('youtube')).toBe(2);

    selector.upsert(session({tabId:4,source:'youtube',lastAccessed:200}));
    selector.upsert(session({tabId:2,source:'youtube',lastAccessed:100}));
    expect(selector.chooseFallback('youtube')).toBe(4);
  });

  it('keeps YouTube and YouTube Music selections independent',()=>{
    const selector=new MediaTabSelector();
    selector.upsert(session({tabId:1,source:'youtube'}));
    selector.upsert(session({tabId:2,source:'youtube_music'}));

    selector.select('youtube',1);
    selector.select('youtube_music',2);

    expect(selector.selections()).toEqual({youtube:1,youtube_music:2});
  });

  it('clears a selected tab when it is removed',()=>{
    const selector=new MediaTabSelector();
    selector.upsert(session({tabId:7,source:'youtube'}));
    selector.select('youtube',7);

    expect(selector.remove(7)).toBe('youtube');
    expect(selector.selectedTabId('youtube')).toBeUndefined();
    expect(selector.chooseFallback('youtube')).toBeUndefined();
  });

  it('rejects selecting a tab registered for another source',()=>{
    const selector=new MediaTabSelector();
    selector.upsert(session({tabId:3,source:'youtube_music'}));

    expect(selector.select('youtube',3)).toBe(false);
    expect(selector.selectedTabId('youtube')).toBeUndefined();
  });
});

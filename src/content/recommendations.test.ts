import {describe,expect,it,vi} from 'vitest';
import {clickYouTubeMusicRecommendation,extractRecommendations,limitUniqueRecommendations,normalizeVideoUrl,videoIdFromThumbnailUrl,youtubeMusicSelectionId,type RecommendationItem} from './recommendations';

function fakeQueueText(value:string):Element {
  return {getAttribute:()=>null,textContent:value} as unknown as Element;
}

function fakeQueueItem(options:{videoId?:string;title:string;artist:string;duration:string;selected?:boolean;click?:()=>void}):Element {
  const playButton={click:options.click||(()=>undefined)} as unknown as HTMLElement;
  return {
    hasAttribute:(name:string)=>name==='selected'&&options.selected===true,
    getAttribute:(name:string)=>{
      if(name==='video-id')return options.videoId;
      if(name==='play-button-state')return options.selected?'paused':null;
      return null;
    },
    querySelector:(selector:string)=>{
      if(selector==='.song-title')return fakeQueueText(options.title);
      if(selector==='.byline')return fakeQueueText(options.artist);
      if(selector==='.duration')return fakeQueueText(options.duration);
      if(selector.startsWith('ytmusic-play-button-renderer'))return playButton;
      return null;
    },
    querySelectorAll:()=>[],
  } as unknown as Element;
}

function fakeQueueDocument(items:Element[]):Document {
  return {querySelectorAll:()=>items} as unknown as Document;
}

describe('recommendations',()=>{
  it('normalizes only video URLs from the requested service',()=>{
    expect(normalizeVideoUrl('/watch?v=abc123&list=ignored','youtube')).toEqual({videoId:'abc123',url:'https://www.youtube.com/watch?v=abc123'});
    expect(normalizeVideoUrl('https://music.youtube.com/watch?v=song1','youtube_music')).toEqual({videoId:'song1',url:'https://music.youtube.com/watch?v=song1'});
    expect(normalizeVideoUrl('https://music.youtube.com/watch?v=song1','youtube')).toBeUndefined();
  });
  it('deduplicates and limits the console list to eight items',()=>{
    const make=(selectionId:string,queueIndex=0):RecommendationItem=>({selectionId,queueIndex,title:selectionId,artist:'',duration:'',url:`https://www.youtube.com/watch?v=${selectionId}`,thumbnailUrl:''});
    const items=[make('one'),make('one'),...Array.from({length:10},(_,index)=>make(`video-${index}`))];
    const result=limitUniqueRecommendations(items,8);
    expect(result).toHaveLength(8);
    expect(result.map(item=>item.selectionId)).toEqual(['one','video-0','video-1','video-2','video-3','video-4','video-5','video-6']);
  });
  it('recovers YouTube Music video IDs from queue thumbnail URLs',()=>{
    expect(videoIdFromThumbnailUrl('https://i.ytimg.com/vi/oj3iiOs6bSk/hqdefault.jpg?sqp=test')).toBe('oj3iiOs6bSk');
    expect(videoIdFromThumbnailUrl('https://i.ytimg.com/vi_webp/KJzmhOkm4-E/maxresdefault.webp')).toBe('KJzmhOkm4-E');
    expect(videoIdFromThumbnailUrl('https://example.com/image.jpg')).toBeUndefined();
  });
  it('clicks the matching YouTube Music queue play button after the selected item',()=>{
    const click=vi.fn();
    const documentRoot=fakeQueueDocument([
      fakeQueueItem({videoId:'current1',title:'Current',artist:'Artist',duration:'3:00',selected:true}),
      fakeQueueItem({videoId:'target12',title:'Target',artist:'Artist',duration:'4:00',click}),
    ]);
    const target:RecommendationItem={selectionId:youtubeMusicSelectionId(0,'Target','Artist','4:00'),queueIndex:0,title:'Target',artist:'Artist',duration:'4:00',url:'',thumbnailUrl:''};

    expect(clickYouTubeMusicRecommendation(documentRoot,target)).toBe(true);
    expect(click).toHaveBeenCalledOnce();
  });
  it('does not navigate or click when a YouTube Music queue item is stale',()=>{
    const click=vi.fn();
    const documentRoot=fakeQueueDocument([
      fakeQueueItem({videoId:'current1',title:'Current',artist:'Artist',duration:'3:00',selected:true}),
      fakeQueueItem({videoId:'other123',title:'Other',artist:'Artist',duration:'4:00',click}),
    ]);
    const stale:RecommendationItem={selectionId:youtubeMusicSelectionId(0,'Missing','Artist','4:00'),queueIndex:0,title:'Missing',artist:'Artist',duration:'4:00',url:'',thumbnailUrl:''};

    expect(clickYouTubeMusicRecommendation(documentRoot,stale)).toBe(false);
    expect(click).not.toHaveBeenCalled();
  });
  it('matches the live YouTube Music queue metadata when its video ID attribute is missing',()=>{
    const click=vi.fn();
    const documentRoot=fakeQueueDocument([
      fakeQueueItem({videoId:'current1',title:'Current',artist:'Artist',duration:'3:00',selected:true}),
      fakeQueueItem({title:'Target',artist:'Artist',duration:'4:00',click}),
    ]);
    const target:RecommendationItem={selectionId:youtubeMusicSelectionId(0,'Target','Artist','4:00'),queueIndex:0,title:'Target',artist:'Artist',duration:'4:00',url:'',thumbnailUrl:''};

    expect(clickYouTubeMusicRecommendation(documentRoot,target)).toBe(true);
    expect(click).toHaveBeenCalledOnce();
  });
  it('keeps the first eight YouTube Music queue rows in order without video IDs or links',()=>{
    const items=[
      fakeQueueItem({title:'Current',artist:'Artist',duration:'3:00',selected:true}),
      ...Array.from({length:10},(_,index)=>fakeQueueItem({title:`Track ${index+1}`,artist:`Artist ${index+1}`,duration:`3:0${index}`})),
    ];

    const result=extractRecommendations(fakeQueueDocument(items),'youtube_music',8);

    expect(result).toHaveLength(8);
    expect(result.map(item=>item.title)).toEqual(['Track 1','Track 2','Track 3','Track 4','Track 5','Track 6','Track 7','Track 8']);
    expect(new Set(result.map(item=>item.selectionId)).size).toBe(8);
    expect(result.map(item=>item.queueIndex)).toEqual([0,1,2,3,4,5,6,7]);
  });
});

import type {RecommendationItem} from '../shared/protocol';

export type RecommendationSource='youtube'|'youtube_music';
export type {RecommendationItem} from '../shared/protocol';

const text=(value:string|null|undefined)=>value?.replace(/\s+/g,' ').trim()||'';

function elementText(root:Element,selectors:string[]):string {
  for(const selector of selectors){
    const element=root.querySelector<HTMLElement>(selector);
    const value=text(element?.getAttribute('title')||element?.getAttribute('aria-label')||element?.textContent);
    if(value)return value;
  }
  return '';
}

function thumbnailUrl(root:Element):string {
  for(const image of Array.from(root.querySelectorAll<HTMLImageElement>('img'))){
    const candidate=image.currentSrc||image.src||image.getAttribute('data-thumb')||image.getAttribute('data-src')||'';
    if(/^https:\/\//i.test(candidate))return candidate;
  }
  return '';
}

export function videoIdFromThumbnailUrl(rawUrl:string):string|undefined {
  try{
    const parsed=new URL(rawUrl);
    const match=parsed.pathname.match(/\/vi(?:_webp)?\/([A-Za-z0-9_-]{6,32})(?:\/|$)/);
    return match?.[1];
  }catch{return undefined;}
}

export function normalizeVideoUrl(rawUrl:string,source:RecommendationSource):{videoId:string;url:string}|undefined {
  try{
    const base=source==='youtube'?'https://www.youtube.com/':'https://music.youtube.com/';
    const parsed=new URL(rawUrl,base);
    const expectedHost=source==='youtube'?'www.youtube.com':'music.youtube.com';
    const videoId=parsed.searchParams.get('v')||'';
    if(parsed.hostname!==expectedHost||parsed.pathname!=='/watch'||!videoId)return undefined;
    return {videoId,url:`${parsed.origin}/watch?v=${encodeURIComponent(videoId)}`};
  }catch{return undefined;}
}

export function youtubeMusicSelectionId(queueIndex:number,title:string,artist:string,duration:string):string {
  const value=`${queueIndex}\u0000${title}\u0000${artist}\u0000${duration}`;
  let hash=2166136261;
  for(let index=0;index<value.length;index++){
    hash^=value.charCodeAt(index);
    hash=Math.imul(hash,16777619);
  }
  return `ytm_${queueIndex}_${(hash>>>0).toString(36)}`;
}

function uniqueElements(documentRoot:Document,selectors:string[]):Element[]{
  const found=new Set<Element>();
  for(const selector of selectors)for(const element of Array.from(documentRoot.querySelectorAll(selector)))found.add(element);
  return [...found];
}

const youtubeMusicQueueSelectors=[
  'ytmusic-player-queue #contents ytmusic-player-queue-item',
  'ytmusic-player-queue-item',
];

function youtubeMusicQueueContainers(documentRoot:Document):Element[]{
  return uniqueElements(documentRoot,youtubeMusicQueueSelectors);
}

function upcomingYouTubeMusicQueueContainers(documentRoot:Document):Element[]{
  const containers=youtubeMusicQueueContainers(documentRoot);
  const selectedIndex=containers.findIndex(container=>container.hasAttribute('selected')||container.getAttribute('aria-current')==='true'||container.getAttribute('play-button-state')==='playing');
  return selectedIndex>=0?containers.slice(selectedIndex+1):containers;
}

interface YouTubeMusicQueueMetadata {
  videoId?:string;
  title:string;
  artist:string;
  duration:string;
  url?:string;
  thumbnailUrl:string;
}

function youtubeMusicQueueMetadata(container:Element):YouTubeMusicQueueMetadata {
  const title=elementText(container,['.song-title','yt-formatted-string.song-title','#title']);
  const artist=elementText(container,['.byline','.secondary-flex-columns','.subtitle','#byline']);
  const duration=elementText(container,['.duration','#duration']);
  const anchor=container.querySelector<HTMLAnchorElement>('a[href*="watch?v="]');
  const attributeId=container.getAttribute('video-id')||container.getAttribute('data-video-id')||'';
  const image=thumbnailUrl(container);
  const target=normalizeVideoUrl(anchor?.href||anchor?.getAttribute('href')||(attributeId?`/watch?v=${attributeId}`:''),'youtube_music');
  return {
    videoId:target?.videoId||attributeId||videoIdFromThumbnailUrl(image),
    title,
    artist,
    duration,
    url:target?.url,
    thumbnailUrl:image,
  };
}

function extractYouTube(documentRoot:Document):RecommendationItem[]{
  const containers=uniqueElements(documentRoot,[
    'ytd-watch-next-secondary-results-renderer ytd-compact-video-renderer',
    '#related ytd-compact-video-renderer',
    'ytd-watch-next-secondary-results-renderer yt-lockup-view-model',
    '#related yt-lockup-view-model',
  ]);
  return containers.flatMap((container,queueIndex)=>{
    const anchors=Array.from(container.querySelectorAll<HTMLAnchorElement>('a[href*="/watch?v="]'));
    const anchor=anchors.find(candidate=>text(candidate.getAttribute('title')||candidate.getAttribute('aria-label')||candidate.textContent))||anchors[0];
    const target=normalizeVideoUrl(anchor?.href||anchor?.getAttribute('href')||'','youtube');
    const title=text(container.querySelector<HTMLElement>('#video-title')?.getAttribute('title'))||elementText(container,['#video-title','yt-formatted-string#video-title','.yt-lockup-metadata-view-model__title','.yt-lockup-metadata-view-model__title span','h3'])||text(anchor?.getAttribute('title')||anchor?.getAttribute('aria-label')||anchor?.textContent);
    if(!target||!title)return [];
    return [{selectionId:target.videoId,queueIndex,title,artist:elementText(container,['#channel-name a','.ytd-channel-name a','#byline','.yt-content-metadata-view-model__metadata-row a','.yt-lockup-metadata-view-model__metadata a']),duration:elementText(container,['ytd-thumbnail-overlay-time-status-renderer #text','.ytd-thumbnail-overlay-time-status-renderer','.yt-badge-shape__text','.yt-content-metadata-view-model__metadata-text']),url:target.url,thumbnailUrl:thumbnailUrl(container)}];
  });
}

function extractYouTubeMusic(documentRoot:Document):RecommendationItem[]{
  return upcomingYouTubeMusicQueueContainers(documentRoot).flatMap((container,queueIndex)=>{
    const metadata=youtubeMusicQueueMetadata(container);
    if(!metadata.title)return [];
    return [{
      selectionId:youtubeMusicSelectionId(queueIndex,metadata.title,metadata.artist,metadata.duration),
      queueIndex,
      title:metadata.title,
      artist:metadata.artist,
      duration:metadata.duration,
      url:metadata.url||'',
      thumbnailUrl:metadata.thumbnailUrl,
    }];
  });
}

function matchesYouTubeMusicRecommendation(metadata:YouTubeMusicQueueMetadata,recommendation:RecommendationItem):boolean {
  return metadata.title===recommendation.title
    && (!recommendation.artist||metadata.artist===recommendation.artist)
    && (!recommendation.duration||metadata.duration===recommendation.duration);
}

export function clickYouTubeMusicRecommendation(documentRoot:Document,recommendation:RecommendationItem):boolean {
  const containers=upcomingYouTubeMusicQueueContainers(documentRoot);
  const positioned=containers[recommendation.queueIndex];
  const container=positioned&&matchesYouTubeMusicRecommendation(youtubeMusicQueueMetadata(positioned),recommendation)
    ?positioned
    :containers.find(candidate=>matchesYouTubeMusicRecommendation(youtubeMusicQueueMetadata(candidate),recommendation));
  const playButton=container?.querySelector<HTMLElement>('ytmusic-play-button-renderer#play-button[role="button"],ytmusic-item-thumbnail-overlay-renderer [role="button"]');
  if(!playButton)return false;
  playButton.click();
  return true;
}

export function limitUniqueRecommendations(items:RecommendationItem[],limit=8):RecommendationItem[]{
  const unique=new Map<string,RecommendationItem>();
  for(const item of items){
    const key=item.selectionId;
    if(!unique.has(key))unique.set(key,item);
    if(unique.size>=limit)break;
  }
  return [...unique.values()];
}

export function extractRecommendations(documentRoot:Document,source:RecommendationSource,limit=8):RecommendationItem[]{
  return limitUniqueRecommendations(source==='youtube'?extractYouTube(documentRoot):extractYouTubeMusic(documentRoot),limit);
}

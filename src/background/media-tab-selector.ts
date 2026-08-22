import type {MediaSource} from '../shared/media-source';

export interface MediaTabSession {
  tabId:number;
  source:MediaSource;
  playing:boolean;
  lastAccessed:number;
  updatedAt:number;
}

export type SelectedMediaTabs=Partial<Record<MediaSource,number>>;

export class MediaTabSelector {
  private readonly sessions=new Map<number,MediaTabSession>();
  private readonly selected:SelectedMediaTabs={};

  upsert(session:MediaTabSession):void {
    this.sessions.set(session.tabId,session);
  }

  session(tabId:number):MediaTabSession|undefined {
    return this.sessions.get(tabId);
  }

  sessionsFor(source:MediaSource):MediaTabSession[] {
    return [...this.sessions.values()].filter(session=>session.source===source);
  }

  select(source:MediaSource,tabId:number):boolean {
    if(this.sessions.get(tabId)?.source!==source)return false;
    this.selected[source]=tabId;
    return true;
  }

  selectedTabId(source:MediaSource):number|undefined {
    return this.selected[source];
  }

  isSelected(source:MediaSource,tabId:number):boolean {
    return this.selected[source]===tabId;
  }

  clear(source:MediaSource):void {
    delete this.selected[source];
  }

  remove(tabId:number):MediaSource|undefined {
    const session=this.sessions.get(tabId);
    this.sessions.delete(tabId);
    if(!session||this.selected[session.source]!==tabId)return undefined;
    delete this.selected[session.source];
    return session.source;
  }

  selectedSourceForTab(tabId:number):MediaSource|undefined {
    if(this.selected.youtube===tabId)return 'youtube';
    if(this.selected.youtube_music===tabId)return 'youtube_music';
    return undefined;
  }

  chooseFallback(source:MediaSource,focusedActiveTabId?:number):number|undefined {
    if(focusedActiveTabId!==undefined&&this.sessions.get(focusedActiveTabId)?.source===source){
      return focusedActiveTabId;
    }

    const candidates=[...this.sessions.values()].filter(session=>session.source===source);
    candidates.sort((left,right)=>{
      if(left.playing!==right.playing)return left.playing?-1:1;
      if(left.lastAccessed!==right.lastAccessed)return right.lastAccessed-left.lastAccessed;
      return left.tabId-right.tabId;
    });
    return candidates[0]?.tabId;
  }

  selections():SelectedMediaTabs {
    return {...this.selected};
  }
}

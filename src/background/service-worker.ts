import {MEDIA_SOURCE_URL_PATTERNS,isMediaSource,sourceFromUrl,type MediaSource} from '../shared/media-source';
import {isCommand,isRecommendationList,isRecommendationSelection} from '../shared/protocol';
import {MediaTabSelector,type SelectedMediaTabs} from './media-tab-selector';

const SOURCES:MediaSource[]=['youtube','youtube_music'];
const SESSION_STORAGE_KEY='selectedMediaTabsV1';
const DEBUG=false;
const log=(...args:unknown[])=>{if(DEBUG)console.info('[ChromeMediaControl][DEBUG][worker]',...args);};

const selector=new MediaTabSelector();
const unavailablePublished=new Set<MediaSource>();
const sourceQueues:Record<MediaSource,Promise<unknown>>={
  youtube:Promise.resolve(),
  youtube_music:Promise.resolve(),
};
const lastAppliedActivation:Record<MediaSource,number>={youtube:0,youtube_music:0};
let activationSequence=0;
let offscreenCreation:Promise<void>|undefined;
let pendingRoutingActions:Promise<void>=Promise.resolve();

function isStoredSelections(value:unknown):value is SelectedMediaTabs {
  if(typeof value!=='object'||value===null||Array.isArray(value))return false;
  const stored=value as Record<string,unknown>;
  return SOURCES.every(source=>stored[source]===undefined||(Number.isInteger(stored[source])&&Number(stored[source])>=0));
}

function registerTab(tab:chrome.tabs.Tab,source:MediaSource,playing?:boolean):void {
  if(tab.id===undefined)return;
  const existing=selector.session(tab.id);
  selector.upsert({
    tabId:tab.id,
    source,
    playing:playing??(existing?.source===source?existing.playing:false),
    lastAccessed:typeof tab.lastAccessed==='number'?tab.lastAccessed:(existing?.lastAccessed??0),
    updatedAt:playing===undefined?(existing?.updatedAt??0):Date.now(),
  });
}

async function persistSelections():Promise<void> {
  try{
    await chrome.storage.session.set({[SESSION_STORAGE_KEY]:selector.selections()});
  }catch(error){
    console.warn('[ChromeMediaControl][worker] unable to persist selected tabs',error);
  }
}

async function restoreSelections():Promise<void> {
  try{
    const storedResult=await chrome.storage.session.get(SESSION_STORAGE_KEY);
    const stored=storedResult[SESSION_STORAGE_KEY];
    let changed=!isStoredSelections(stored);
    if(isStoredSelections(stored)){
      for(const source of SOURCES){
        const tabId=stored[source];
        if(tabId===undefined)continue;
        try{
          const tab=await chrome.tabs.get(tabId);
          if(sourceFromUrl(tab.url)!==source){changed=true;continue;}
          registerTab(tab,source);
          if(!selector.select(source,tabId))changed=true;
        }catch{
          changed=true;
        }
      }
    }
    if(changed)await persistSelections();
    for(const source of SOURCES){
      const tabId=selector.selectedTabId(source);
      if(tabId!==undefined)void requestSnapshot(source,tabId);
    }
  }catch(error){
    console.warn('[ChromeMediaControl][worker] unable to restore selected tabs',error);
  }
}

const selectionReady=restoreSelections();

function enqueueForSource<T>(source:MediaSource,operation:()=>Promise<T>):Promise<T> {
  const next=sourceQueues[source]
    .catch(()=>undefined)
    .then(()=>selectionReady)
    .then(operation);
  sourceQueues[source]=next.catch(error=>{
    console.warn('[ChromeMediaControl][worker] source routing failed',source,error);
  });
  return next;
}

function trackRoutingAction(action:Promise<unknown>):void {
  pendingRoutingActions=Promise.all([
    pendingRoutingActions.catch(()=>undefined),
    action.catch(error=>log('routing action failed',error)),
  ]).then(()=>undefined);
}

function ensureOffscreen():Promise<void> {
  if(offscreenCreation)return offscreenCreation;
  offscreenCreation=(async()=>{
    const contexts=await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType]});
    log('offscreen contexts',contexts.length);
    if(contexts.length===0){
      await chrome.offscreen.createDocument({
        url:'offscreen.html',
        reasons:[chrome.offscreen.Reason.WORKERS],
        justification:'Maintain the local Stream Deck WebSocket connection.',
      });
      log('offscreen created');
    }
  })().finally(()=>{offscreenCreation=undefined;});
  return offscreenCreation;
}

async function relayToOffscreen(message:object):Promise<void> {
  await ensureOffscreen();
  await chrome.runtime.sendMessage({...message,target:'offscreen',timestamp:Date.now()});
}

async function clearRecommendations(source:MediaSource):Promise<void> {
  await relayToOffscreen({
    protocolVersion:1,
    type:'recommendation-list',
    source,
    revision:0,
    items:[],
  });
}

async function publishUnavailable(source:MediaSource):Promise<void> {
  if(unavailablePublished.has(source))return;
  unavailablePublished.add(source);
  await relayToOffscreen({
    protocolVersion:1,
    type:'player-state',
    source,
    connected:true,
    tabAvailable:false,
    playing:false,
    title:'',
    artist:'',
    currentTime:0,
    duration:0,
    progress:0,
  });
  await clearRecommendations(source);
}

async function requestSnapshot(source:MediaSource,tabId:number):Promise<void> {
  try{
    await chrome.tabs.sendMessage(tabId,{type:'command',source,command:'request-state'});
  }catch(error){
    log('snapshot request deferred',source,tabId,error);
  }
}

async function applySelection(source:MediaSource,tabId:number):Promise<number|undefined> {
  if(selector.selectedTabId(source)===tabId)return tabId;
  if(!selector.select(source,tabId))return undefined;
  unavailablePublished.delete(source);
  await persistSelections();
  await clearRecommendations(source);
  await requestSnapshot(source,tabId);
  log('primary selected',source,tabId);
  return tabId;
}

async function refreshCandidates(source:MediaSource):Promise<number|undefined> {
  const [tabs,focusedTabs]=await Promise.all([
    chrome.tabs.query({url:MEDIA_SOURCE_URL_PATTERNS[source]}),
    chrome.tabs.query({url:MEDIA_SOURCE_URL_PATTERNS[source],active:true,lastFocusedWindow:true}),
  ]);
  const liveIds=new Set<number>();
  for(const tab of tabs){
    if(tab.id===undefined)continue;
    liveIds.add(tab.id);
    registerTab(tab,source);
  }
  for(const session of selector.sessionsFor(source)){
    if(!liveIds.has(session.tabId))selector.remove(session.tabId);
  }
  return focusedTabs.find(tab=>tab.id!==undefined)?.id;
}

async function resolvePrimary(source:MediaSource):Promise<number|undefined> {
  const current=selector.selectedTabId(source);
  if(current!==undefined){
    try{
      const tab=await chrome.tabs.get(current);
      if(sourceFromUrl(tab.url)===source){
        registerTab(tab,source);
        unavailablePublished.delete(source);
        return current;
      }
    }catch{
      // The selected tab no longer exists.
    }
    selector.remove(current);
    selector.clear(source);
    await persistSelections();
  }

  const focusedActiveTabId=await refreshCandidates(source);
  const fallback=selector.chooseFallback(source,focusedActiveTabId);
  if(fallback===undefined){
    selector.clear(source);
    await persistSelections();
    await publishUnavailable(source);
    return undefined;
  }
  return applySelection(source,fallback);
}

async function selectFromUserAction(source:MediaSource,tab:chrome.tabs.Tab,order:number):Promise<void> {
  if(order<lastAppliedActivation[source])return;
  lastAppliedActivation[source]=order;
  registerTab(tab,source);
  await applySelection(source,tab.id as number);
}

async function removeAndFallback(source:MediaSource,tabId:number):Promise<void> {
  const wasSelected=selector.selectedTabId(source)===tabId;
  selector.remove(tabId);
  if(!wasSelected)return;
  selector.clear(source);
  await persistSelections();
  await resolvePrimary(source);
}

async function handleStateMessage(message:Record<string,unknown>,tab:chrome.tabs.Tab):Promise<void> {
  if(tab.id===undefined)return;
  const source=sourceFromUrl(tab.url);
  if(!source||(isMediaSource(message.source)&&message.source!==source))return;
  const previous=selector.session(tab.id);
  if(previous&&previous.source!==source){
    await enqueueForSource(previous.source,()=>removeAndFallback(previous.source,tab.id as number));
  }
  await enqueueForSource(source,async()=>{
    registerTab(tab,source,message.playing===true);
    const primary=await resolvePrimary(source);
    if(primary!==tab.id)return;
    await relayToOffscreen({
      ...message,
      source,
      protocolVersion:1,
      type:'player-state',
      connected:true,
      tabAvailable:true,
    });
  });
}

async function handleRecommendationMessage(message:unknown,tab:chrome.tabs.Tab):Promise<void> {
  if(tab.id===undefined||!isRecommendationList(message))return;
  const source=sourceFromUrl(tab.url);
  if(source!==message.source)return;
  const previous=selector.session(tab.id);
  if(previous&&previous.source!==source){
    await enqueueForSource(previous.source,()=>removeAndFallback(previous.source,tab.id as number));
  }
  await enqueueForSource(source,async()=>{
    registerTab(tab,source);
    const primary=await resolvePrimary(source);
    if(primary!==tab.id)return;
    await relayToOffscreen(message);
  });
}

chrome.runtime.onStartup.addListener(()=>{
  ensureOffscreen().catch(error=>console.warn('[ChromeMediaControl] offscreen startup',error));
});

chrome.runtime.onInstalled.addListener(()=>{
  ensureOffscreen().catch(error=>console.warn('[ChromeMediaControl] offscreen install',error));
});

chrome.tabs.onActivated.addListener(({tabId})=>{
  const order=++activationSequence;
  trackRoutingAction(chrome.tabs.get(tabId).then(tab=>{
    const source=sourceFromUrl(tab.url);
    if(!source)return;
    return enqueueForSource(source,()=>selectFromUserAction(source,tab,order));
  }).catch(error=>log('activated tab lookup failed',tabId,error)));
});

chrome.windows.onFocusChanged.addListener(windowId=>{
  if(windowId===chrome.windows.WINDOW_ID_NONE)return;
  const order=++activationSequence;
  trackRoutingAction(chrome.tabs.query({active:true,windowId}).then(tabs=>{
    const tab=tabs[0];
    const source=sourceFromUrl(tab?.url);
    if(!tab||!source)return;
    return enqueueForSource(source,()=>selectFromUserAction(source,tab,order));
  }).catch(error=>log('focused window lookup failed',windowId,error)));
});

chrome.tabs.onRemoved.addListener(tabId=>{
  const source=selector.session(tabId)?.source??selector.selectedSourceForTab(tabId);
  if(!source)return;
  trackRoutingAction(enqueueForSource(source,()=>removeAndFallback(source,tabId)));
});

chrome.tabs.onUpdated.addListener((tabId,changeInfo,tab)=>{
  if(changeInfo.url===undefined)return;
  const previousSource=selector.session(tabId)?.source??selector.selectedSourceForTab(tabId);
  const nextSource=sourceFromUrl(tab.url);
  const order=++activationSequence;
  trackRoutingAction((async()=>{
    if(previousSource&&previousSource!==nextSource){
      await enqueueForSource(previousSource,()=>removeAndFallback(previousSource,tabId));
    }
    if(!nextSource||!tab.active)return;
    await enqueueForSource(nextSource,()=>selectFromUserAction(nextSource,tab,order));
  })().catch(error=>log('updated tab routing failed',tabId,error)));
});

chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
  log('message',message?.type,'senderTab',sender.tab?.id,'target',message?.target);
  if((message?.type==='state'||message?.type==='player-state')&&sender.tab?.id!==undefined){
    void handleStateMessage(message as Record<string,unknown>,sender.tab).catch(error=>{
      console.warn('[ChromeMediaControl][worker] state relay failed',error);
    });
    return;
  }
  if(isRecommendationList(message)&&sender.tab?.id!==undefined){
    void handleRecommendationMessage(message,sender.tab).catch(error=>{
      console.warn('[ChromeMediaControl][worker] recommendation relay failed',error);
    });
    return;
  }
  if(isCommand(message)||isRecommendationSelection(message)){
    const routingReady=pendingRoutingActions;
    void routingReady.then(()=>enqueueForSource(message.source,async()=>{
      const tabId=await resolvePrimary(message.source);
      if(tabId===undefined){
        sendResponse({success:false,error:`${message.source} tab not found`});
        return;
      }
      const payload=message.type==='command'
        ?{type:'command',source:message.source,command:message.command}
        :{type:'select-recommendation',source:message.source,revision:message.revision,selectionId:message.selectionId};
      try{
        const response=await chrome.tabs.sendMessage(tabId,payload);
        sendResponse(response??{success:true});
      }catch(error){
        console.warn('[ChromeMediaControl][worker] message delivery failed',error);
        sendResponse({success:false,error:'Media content script unavailable; reload the tab'});
      }
    })).catch(error=>{
      console.warn('[ChromeMediaControl][worker] command routing failed',error);
      sendResponse({success:false,error:'Unable to query media tabs'});
    });
    return true;
  }
});

ensureOffscreen().catch(error=>console.warn('[ChromeMediaControl] offscreen init',error));

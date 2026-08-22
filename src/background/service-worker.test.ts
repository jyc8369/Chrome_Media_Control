import {afterEach,describe,expect,it,vi} from 'vitest';

type Listener=(...args:any[])=>any;

function createEvent<T extends Listener>(){
  const listeners:T[]=[];
  return {
    listeners,
    event:{addListener:(listener:T)=>{listeners.push(listener);}},
  };
}

interface HarnessOptions {
  tabs:chrome.tabs.Tab[];
  selected?:Partial<Record<'youtube'|'youtube_music',number>>;
  focusedWindowId?:number;
}

async function createHarness(options:HarnessOptions){
  vi.resetModules();

  const runtimeOnMessage=createEvent<Parameters<typeof chrome.runtime.onMessage.addListener>[0]>();
  const runtimeOnStartup=createEvent<Parameters<typeof chrome.runtime.onStartup.addListener>[0]>();
  const runtimeOnInstalled=createEvent<Parameters<typeof chrome.runtime.onInstalled.addListener>[0]>();
  const tabsOnActivated=createEvent<Parameters<typeof chrome.tabs.onActivated.addListener>[0]>();
  const tabsOnRemoved=createEvent<Parameters<typeof chrome.tabs.onRemoved.addListener>[0]>();
  const tabsOnUpdated=createEvent<Parameters<typeof chrome.tabs.onUpdated.addListener>[0]>();
  const windowsOnFocusChanged=createEvent<Parameters<typeof chrome.windows.onFocusChanged.addListener>[0]>();

  const tabs=new Map(options.tabs.map(tab=>[tab.id as number,{...tab}]));
  const storage:Record<string,unknown>=options.selected?{selectedMediaTabsV1:{...options.selected}}:{};
  const relayed:Record<string,unknown>[]=[];
  const tabMessages:{tabId:number;message:Record<string,unknown>}[]=[];
  let focusedWindowId=options.focusedWindowId??1;

  function matchesUrl(tab:chrome.tabs.Tab,query:chrome.tabs.QueryInfo):boolean {
    if(query.windowId!==undefined&&tab.windowId!==query.windowId)return false;
    if(query.active!==undefined&&tab.active!==query.active)return false;
    if(query.lastFocusedWindow&&tab.windowId!==focusedWindowId)return false;
    if(query.url===undefined)return true;
    const patterns=Array.isArray(query.url)?query.url:[query.url];
    return patterns.some(pattern=>tab.url?.startsWith(pattern.replace('*','')));
  }

  const chromeMock={
    runtime:{
      onMessage:runtimeOnMessage.event,
      onStartup:runtimeOnStartup.event,
      onInstalled:runtimeOnInstalled.event,
      getContexts:vi.fn(async()=>[{}]),
      sendMessage:vi.fn(async(message:Record<string,unknown>)=>{relayed.push(message);}),
    },
    offscreen:{
      Reason:{WORKERS:'WORKERS'},
      createDocument:vi.fn(async()=>undefined),
    },
    storage:{
      session:{
        get:vi.fn(async(key:string)=>({[key]:storage[key]})),
        set:vi.fn(async(value:Record<string,unknown>)=>{Object.assign(storage,value);}),
      },
    },
    tabs:{
      onActivated:tabsOnActivated.event,
      onRemoved:tabsOnRemoved.event,
      onUpdated:tabsOnUpdated.event,
      get:vi.fn(async(tabId:number)=>{
        const tab=tabs.get(tabId);
        if(!tab)throw new Error('No tab');
        return {...tab};
      }),
      query:vi.fn(async(query:chrome.tabs.QueryInfo)=>[...tabs.values()].filter(tab=>matchesUrl(tab,query)).map(tab=>({...tab}))),
      sendMessage:vi.fn(async(tabId:number,message:Record<string,unknown>)=>{
        tabMessages.push({tabId,message});
        return {success:true};
      }),
    },
    windows:{
      WINDOW_ID_NONE:-1,
      onFocusChanged:windowsOnFocusChanged.event,
    },
  } as unknown as typeof chrome;

  vi.stubGlobal('chrome',chromeMock);
  await import('./service-worker');
  await vi.waitFor(()=>expect(chromeMock.storage.session.get).toHaveBeenCalled());

  const runtimeListener=runtimeOnMessage.listeners[0];

  function playerState(source:'youtube'|'youtube_music',title:string,playing=false){
    return {
      protocolVersion:1,
      type:'player-state',
      timestamp:Date.now(),
      source,
      title,
      artist:'Artist',
      playing,
      currentTime:10,
      duration:100,
      progress:10,
    };
  }

  function emitState(tabId:number,message:Record<string,unknown>):void {
    const tab=tabs.get(tabId);
    if(!tab)throw new Error('No tab');
    runtimeListener(message,{tab:{...tab}},()=>undefined);
  }

  function emitCommand(message:Record<string,unknown>):Promise<unknown> {
    return new Promise(resolve=>{
      runtimeListener(message,{},resolve);
    });
  }

  function activate(tabId:number):void {
    const target=tabs.get(tabId);
    if(!target)throw new Error('No tab');
    for(const [id,tab] of tabs){
      if(tab.windowId===target.windowId)tabs.set(id,{...tab,active:id===tabId});
    }
    tabsOnActivated.listeners[0]({tabId,windowId:target.windowId});
  }

  function remove(tabId:number):void {
    const tab=tabs.get(tabId);
    tabs.delete(tabId);
    tabsOnRemoved.listeners[0](tabId,{windowId:tab?.windowId??1,isWindowClosing:false});
  }

  function updateUrl(tabId:number,url:string):void {
    const tab=tabs.get(tabId);
    if(!tab)throw new Error('No tab');
    const updated={...tab,url};
    tabs.set(tabId,updated);
    tabsOnUpdated.listeners[0](tabId,{url},updated);
  }

  function focusWindow(windowId:number):void {
    focusedWindowId=windowId;
    windowsOnFocusChanged.listeners[0](windowId);
  }

  return {
    tabs,
    storage,
    relayed,
    tabMessages,
    playerState,
    emitState,
    emitCommand,
    activate,
    remove,
    updateUrl,
    focusWindow,
  };
}

afterEach(()=>{
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('service worker media tab routing',()=>{
  it('relays only the primary tab and routes commands to the same tab',async()=>{
    const harness=await createHarness({
      tabs:[
        {id:1,windowId:1,active:true,url:'https://www.youtube.com/watch?v=one',lastAccessed:20},
        {id:2,windowId:1,active:false,url:'https://www.youtube.com/watch?v=two',lastAccessed:10},
      ] as chrome.tabs.Tab[],
    });

    harness.emitState(2,harness.playerState('youtube','Background'));
    harness.emitState(1,harness.playerState('youtube','Primary'));
    await vi.waitFor(()=>expect(harness.relayed.some(message=>message.type==='player-state'&&message.title==='Primary')).toBe(true));
    expect(harness.relayed.some(message=>message.type==='player-state'&&message.title==='Background')).toBe(false);

    harness.activate(2);
    const response=await harness.emitCommand({
      protocolVersion:1,
      type:'command',
      timestamp:Date.now(),
      source:'youtube',
      requestId:'request-1',
      command:'pause',
    });
    expect(response).toEqual({success:true});
    expect(harness.tabMessages.some(entry=>entry.tabId===2&&entry.message.command==='pause')).toBe(true);
    expect(harness.tabMessages.some(entry=>entry.tabId===2&&entry.message.command==='request-state')).toBe(true);
    await vi.waitFor(()=>expect((harness.storage.selectedMediaTabsV1 as Record<string,number>).youtube).toBe(2));
    harness.relayed.length=0;
    harness.emitState(1,harness.playerState('youtube','Old Primary'));
    harness.emitState(2,harness.playerState('youtube','New Primary'));
    await vi.waitFor(()=>expect(harness.relayed.some(message=>message.type==='player-state'&&message.title==='New Primary')).toBe(true));
    expect(harness.relayed.some(message=>message.type==='player-state'&&message.title==='Old Primary')).toBe(false);
  });

  it('restores the session selection and falls back when that tab closes',async()=>{
    const harness=await createHarness({
      tabs:[
        {id:1,windowId:1,active:true,url:'https://www.youtube.com/watch?v=one',lastAccessed:30},
        {id:2,windowId:1,active:false,url:'https://www.youtube.com/watch?v=two',lastAccessed:20},
      ] as chrome.tabs.Tab[],
      selected:{youtube:2},
    });

    harness.emitState(1,harness.playerState('youtube','Not Selected'));
    harness.emitState(2,harness.playerState('youtube','Restored'));
    await vi.waitFor(()=>expect(harness.relayed.some(message=>message.type==='player-state'&&message.title==='Restored')).toBe(true));
    expect(harness.relayed.some(message=>message.type==='player-state'&&message.title==='Not Selected')).toBe(false);

    harness.remove(2);
    await vi.waitFor(()=>expect((harness.storage.selectedMediaTabsV1 as Record<string,number>).youtube).toBe(1));
    harness.relayed.length=0;
    harness.emitState(1,harness.playerState('youtube','Fallback'));
    await vi.waitFor(()=>expect(harness.relayed.some(message=>message.type==='player-state'&&message.title==='Fallback')).toBe(true));
  });

  it('publishes unavailable state and empty recommendations when no candidate remains',async()=>{
    const harness=await createHarness({
      tabs:[{id:1,windowId:1,active:true,url:'https://music.youtube.com/watch?v=one',lastAccessed:10}] as chrome.tabs.Tab[],
      selected:{youtube_music:1},
    });

    harness.relayed.length=0;
    harness.remove(1);
    await vi.waitFor(()=>expect(harness.relayed.some(message=>message.type==='player-state'&&message.source==='youtube_music'&&message.tabAvailable===false)).toBe(true));
    expect(harness.relayed.some(message=>message.type==='recommendation-list'&&message.source==='youtube_music'&&Array.isArray(message.items)&&(message.items as unknown[]).length===0)).toBe(true);
  });

  it('falls back when the selected tab navigates away from the supported source',async()=>{
    const harness=await createHarness({
      tabs:[
        {id:1,windowId:1,active:false,url:'https://www.youtube.com/watch?v=one',lastAccessed:10},
        {id:2,windowId:1,active:true,url:'https://www.youtube.com/watch?v=two',lastAccessed:20},
      ] as chrome.tabs.Tab[],
      selected:{youtube:2},
    });

    harness.updateUrl(2,'https://example.com/');
    await vi.waitFor(()=>expect((harness.storage.selectedMediaTabsV1 as Record<string,number>).youtube).toBe(1));
  });

  it('changes the primary tab when another Chrome window gains focus',async()=>{
    const harness=await createHarness({
      tabs:[
        {id:1,windowId:1,active:true,url:'https://www.youtube.com/watch?v=one',lastAccessed:20},
        {id:2,windowId:2,active:true,url:'https://www.youtube.com/watch?v=two',lastAccessed:10},
      ] as chrome.tabs.Tab[],
      selected:{youtube:1},
      focusedWindowId:1,
    });

    harness.focusWindow(2);
    await vi.waitFor(()=>expect((harness.storage.selectedMediaTabsV1 as Record<string,number>).youtube).toBe(2));
  });
});

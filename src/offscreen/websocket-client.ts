const BACKEND_URL='ws://127.0.0.1:17832/api/v1/extension';

let ws:WebSocket|undefined;
let delay=1000;
const latestRecommendations:Record<string,unknown>={};
const DEBUG=false;
const log=(...args:unknown[])=>{if(DEBUG)console.info('[ChromeMediaControl][DEBUG][offscreen]',...args);};

function sendToBackend(message:Record<string,unknown>){
  if(ws?.readyState!==WebSocket.OPEN)return;
  ws.send(JSON.stringify({
    ...message,
    protocolVersion:1,
    type:message.type==='state'?'player-state':message.type,
    timestamp:Date.now(),
    ...(message.type==='state'||message.type==='player-state'?{connected:true,tabAvailable:true}:{}),
  }));
}

async function relayCommand(message:Record<string,unknown>){
  try{
    const response=await chrome.runtime.sendMessage(message) as {success?:boolean;error?:string}|undefined;
    sendToBackend({
      type:'command-result',
      source:message.source,
      requestId:message.requestId,
      success:response?.success===true,
      error:response?.success===true?undefined:response?.error||'Command was not handled',
    });
  }catch(error){
    console.warn('[ChromeMediaControl][DEBUG][offscreen] message relay failed',error);
    sendToBackend({
      type:'command-result',
      source:message.source,
      requestId:message.requestId,
      success:false,
      error:String(error),
    });
  }
}

function connect(){
  log('connecting',BACKEND_URL,delay);
  ws=new WebSocket(BACKEND_URL);
  ws.onopen=()=>{
    delay=1000;
    log('websocket open');
    ws?.send(JSON.stringify({protocolVersion:1,type:'hello',timestamp:Date.now(),client:'chrome-extension'}));
    Object.values(latestRecommendations).forEach(message=>sendToBackend(message as Record<string,unknown>));
  };
  ws.onmessage=event=>{
    try{
      const message=JSON.parse(event.data) as Record<string,unknown>;
      log('received',message.type);
      if(message.type==='command'||message.type==='select-recommendation')void relayCommand(message);
    }catch(error){
      console.warn('[ChromeMediaControl][DEBUG][offscreen] invalid websocket message',error);
    }
  };
  ws.onclose=()=>{
    log('websocket closed');
    setTimeout(connect,delay=Math.min(10000,delay*2));
  };
  ws.onerror=error=>{
    console.warn('[ChromeMediaControl][DEBUG][offscreen] websocket error',error);
    ws?.close();
  };
}

chrome.runtime.onMessage.addListener(message=>{
  log('runtime message',message?.type,'target',message?.target,'socketState',ws?.readyState);
  if((message.type==='state'||message.type==='player-state'||message.type==='recommendation-list')&&(message.target==='offscreen'||message.target===undefined)){
    if(message.type==='recommendation-list'&&typeof message.source==='string')latestRecommendations[message.source]=message;
    sendToBackend(message);
  }
});

connect();

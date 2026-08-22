import {randomUUID} from 'node:crypto';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import {WebSocket,WebSocketServer,type RawData} from 'ws';
import {isMediaSource,type MediaSource} from '../shared/media-source';
import {
  PROTOCOL_VERSION,
  isCommandResult,
  isPlayerCommand,
  isPlayerState,
  isRecommendationList,
  type CommandMessage,
  type CommandResultMessage,
  type PlayerStateMessage,
  type RecommendationListMessage,
  type RecommendationSelectionMessage,
} from '../shared/protocol';

export const LOOPBACK_HOST='127.0.0.1';
export const DEFAULT_PORT=17832;
export const EXTENSION_WEBSOCKET_PATH='/api/v1/extension';

const MAX_BODY_BYTES=64*1024;
const MAX_COMMAND_HISTORY=500;

type StoredMessage<T> = T&{receivedAt:number};
type CommandStatus='pending'|'succeeded'|'failed';

interface CommandRecord {
  requestId:string;
  message:CommandMessage|RecommendationSelectionMessage;
  status:CommandStatus;
  createdAt:number;
  completedAt?:number;
  error?:string;
}

interface ApiErrorBody {
  error:string;
}

class HttpError extends Error {
  constructor(readonly status:number,message:string){super(message);}
}

export interface StartedApiServer {
  host:typeof LOOPBACK_HOST;
  port:number;
}

export interface LocalApiServer {
  start(port?:number):Promise<StartedApiServer>;
  stop():Promise<void>;
}

function isRecord(value:unknown):value is Record<string,unknown> {
  return typeof value==='object'&&value!==null&&!Array.isArray(value);
}

function hostIsAllowed(request:IncomingMessage):boolean {
  const host=request.headers.host||'';
  return host===LOOPBACK_HOST||host.startsWith(`${LOOPBACK_HOST}:`);
}

function originIsAllowed(request:IncomingMessage):boolean {
  const origin=request.headers.origin;
  if(origin===undefined)return true;
  try{return new URL(origin).protocol==='chrome-extension:';}catch{return false;}
}

function requestIsAllowed(request:IncomingMessage):boolean {
  return hostIsAllowed(request)&&originIsAllowed(request);
}

function sendJson(response:ServerResponse,status:number,body:unknown):void {
  const data=JSON.stringify(body);
  response.writeHead(status,{
    'content-type':'application/json; charset=utf-8',
    'content-length':Buffer.byteLength(data),
    'cache-control':'no-store',
  });
  response.end(data);
}

async function readJsonObject(request:IncomingMessage):Promise<Record<string,unknown>> {
  const contentType=request.headers['content-type']?.split(';',1)[0]?.trim().toLowerCase();
  if(contentType!=='application/json')throw new HttpError(415,'Content-Type must be application/json');

  const chunks:Buffer[]=[];
  let total=0;
  for await(const chunk of request){
    const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
    total+=buffer.length;
    if(total>MAX_BODY_BYTES)throw new HttpError(413,'Request body is too large');
    chunks.push(buffer);
  }

  try{
    const parsed=JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if(!isRecord(parsed))throw new Error('JSON object required');
    return parsed;
  }catch{
    throw new HttpError(400,'Request body must be a valid JSON object');
  }
}

function sourcePath(pathname:string,prefix:string):MediaSource|undefined {
  if(!pathname.startsWith(prefix))return undefined;
  const raw=decodeURIComponent(pathname.slice(prefix.length));
  return isMediaSource(raw)?raw:undefined;
}

export function createLocalApiServer():LocalApiServer {
  const states=new Map<MediaSource,StoredMessage<PlayerStateMessage>>();
  const recommendations=new Map<MediaSource,StoredMessage<RecommendationListMessage>>();
  const commands=new Map<string,CommandRecord>();

  const webSockets=new WebSocketServer({noServer:true,maxPayload:MAX_BODY_BYTES});

  function connectedExtensionCount():number {
    let count=0;
    for(const client of webSockets.clients)if(client.readyState===WebSocket.OPEN)count+=1;
    return count;
  }

  function broadcast(message:CommandMessage|RecommendationSelectionMessage):number {
    const data=JSON.stringify(message);
    let sent=0;
    for(const client of webSockets.clients){
      if(client.readyState!==WebSocket.OPEN)continue;
      client.send(data);
      sent+=1;
    }
    return sent;
  }

  function pruneCommandHistory():void {
    while(commands.size>=MAX_COMMAND_HISTORY){
      const oldest=commands.keys().next().value as string|undefined;
      if(oldest===undefined)return;
      commands.delete(oldest);
    }
  }

  function queueCommand(message:CommandMessage|RecommendationSelectionMessage,response:ServerResponse):void {
    if(broadcast(message)===0){
      sendJson(response,503,{error:'Chrome extension is not connected'} satisfies ApiErrorBody);
      return;
    }
    pruneCommandHistory();
    commands.set(message.requestId,{
      requestId:message.requestId,
      message,
      status:'pending',
      createdAt:Date.now(),
    });
    sendJson(response,202,{requestId:message.requestId,status:'pending'});
  }

  function acceptCommandResult(result:CommandResultMessage):void {
    const record=commands.get(result.requestId);
    if(!record||record.message.source!==result.source||record.status!=='pending')return;
    record.status=result.success?'succeeded':'failed';
    record.completedAt=Date.now();
    record.error=result.success?undefined:result.error||'Command failed';
  }

  function handleWebSocketMessage(client:WebSocket,data:RawData):void {
    try{
      const message=JSON.parse(data.toString()) as unknown;
      if(isPlayerState(message)){
        states.set(message.source,{...message,receivedAt:Date.now()});
        return;
      }
      if(isRecommendationList(message)){
        recommendations.set(message.source,{...message,receivedAt:Date.now()});
        return;
      }
      if(isCommandResult(message)){
        acceptCommandResult(message);
        return;
      }
      if(isRecord(message)&&message.type==='hello'&&message.protocolVersion===PROTOCOL_VERSION)return;
      client.send(JSON.stringify({type:'error',code:'invalid-message',timestamp:Date.now()}));
    }catch{
      client.send(JSON.stringify({type:'error',code:'invalid-json',timestamp:Date.now()}));
    }
  }

  webSockets.on('connection',client=>{
    client.on('message',data=>handleWebSocketMessage(client,data));
  });

  async function handleRequest(request:IncomingMessage,response:ServerResponse):Promise<void> {
    if(!requestIsAllowed(request)){
      sendJson(response,403,{error:'Only direct 127.0.0.1 clients and Chrome extensions are allowed'} satisfies ApiErrorBody);
      return;
    }

    const method=request.method||'GET';
    const pathname=new URL(request.url||'/',`http://${LOOPBACK_HOST}`).pathname;

    if(method==='GET'&&pathname==='/api/v1/health'){
      sendJson(response,200,{
        status:'ok',
        host:LOOPBACK_HOST,
        extensionConnected:connectedExtensionCount()>0,
        extensionConnections:connectedExtensionCount(),
      });
      return;
    }

    if(method==='GET'&&pathname==='/api/v1/states'){
      sendJson(response,200,Object.fromEntries(states));
      return;
    }

    if(method==='GET'&&pathname.startsWith('/api/v1/states/')){
      const source=sourcePath(pathname,'/api/v1/states/');
      if(!source){sendJson(response,400,{error:'Unknown media source'} satisfies ApiErrorBody);return;}
      const state=states.get(source);
      if(!state){sendJson(response,404,{error:'State is not available'} satisfies ApiErrorBody);return;}
      sendJson(response,200,state);
      return;
    }

    if(method==='GET'&&pathname.startsWith('/api/v1/recommendations/')){
      const source=sourcePath(pathname,'/api/v1/recommendations/');
      if(!source){sendJson(response,400,{error:'Unknown media source'} satisfies ApiErrorBody);return;}
      const list=recommendations.get(source);
      if(!list){sendJson(response,404,{error:'Recommendations are not available'} satisfies ApiErrorBody);return;}
      sendJson(response,200,list);
      return;
    }

    if(method==='GET'&&pathname.startsWith('/api/v1/commands/')){
      const requestId=decodeURIComponent(pathname.slice('/api/v1/commands/'.length));
      const command=commands.get(requestId);
      if(!command){sendJson(response,404,{error:'Command is not available'} satisfies ApiErrorBody);return;}
      sendJson(response,200,command);
      return;
    }

    if(method==='POST'&&pathname==='/api/v1/commands'){
      const body=await readJsonObject(request);
      if(!isMediaSource(body.source)||!isPlayerCommand(body.command)){
        sendJson(response,400,{error:'source and command are invalid'} satisfies ApiErrorBody);
        return;
      }
      queueCommand({
        protocolVersion:PROTOCOL_VERSION,
        type:'command',
        timestamp:Date.now(),
        source:body.source,
        requestId:randomUUID(),
        command:body.command,
      },response);
      return;
    }

    if(method==='POST'&&pathname==='/api/v1/recommendations/select'){
      const body=await readJsonObject(request);
      if(!isMediaSource(body.source)
        ||!Number.isInteger(body.revision)
        ||Number(body.revision)<0
        ||typeof body.selectionId!=='string'
        ||!/^[A-Za-z0-9_-]{6,64}$/.test(body.selectionId)){
        sendJson(response,400,{error:'source, revision, or selectionId is invalid'} satisfies ApiErrorBody);
        return;
      }
      queueCommand({
        protocolVersion:PROTOCOL_VERSION,
        type:'select-recommendation',
        timestamp:Date.now(),
        source:body.source,
        requestId:randomUUID(),
        revision:Number(body.revision),
        selectionId:body.selectionId,
      },response);
      return;
    }

    sendJson(response,404,{error:'Route not found'} satisfies ApiErrorBody);
  }

  const httpServer=createServer((request,response)=>{
    void handleRequest(request,response).catch(error=>{
      if(response.headersSent){response.end();return;}
      if(error instanceof HttpError){sendJson(response,error.status,{error:error.message});return;}
      console.error('[ChromeMediaControl][API] request failed',error);
      sendJson(response,500,{error:'Internal server error'} satisfies ApiErrorBody);
    });
  });

  httpServer.on('upgrade',(request,socket,head)=>{
    const pathname=new URL(request.url||'/',`http://${LOOPBACK_HOST}`).pathname;
    if(!requestIsAllowed(request)||pathname!==EXTENSION_WEBSOCKET_PATH){
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    webSockets.handleUpgrade(request,socket,head,client=>{
      webSockets.emit('connection',client,request);
    });
  });

  return {
    start(port=DEFAULT_PORT){
      return new Promise((resolve,reject)=>{
        const onError=(error:Error)=>reject(error);
        httpServer.once('error',onError);
        httpServer.listen(port,LOOPBACK_HOST,()=>{
          httpServer.off('error',onError);
          const address=httpServer.address() as AddressInfo;
          resolve({host:LOOPBACK_HOST,port:address.port});
        });
      });
    },
    stop(){
      for(const client of webSockets.clients)client.terminate();
      return new Promise((resolve,reject)=>{
        if(!httpServer.listening){resolve();return;}
        httpServer.close(error=>error?reject(error):resolve());
      });
    },
  };
}

function configuredPort():number {
  const value=Number(process.env.CHROME_MEDIA_CONTROL_PORT||DEFAULT_PORT);
  if(!Number.isInteger(value)||value<1||value>65535)throw new Error('CHROME_MEDIA_CONTROL_PORT must be an integer from 1 to 65535');
  return value;
}

if(require.main===module){
  const api=createLocalApiServer();
  api.start(configuredPort()).then(({host,port})=>{
    console.info(`[ChromeMediaControl][API] listening on http://${host}:${port}`);
  }).catch(error=>{
    console.error('[ChromeMediaControl][API] failed to start',error);
    process.exitCode=1;
  });

  const shutdown=()=>{
    void api.stop().finally(()=>process.exit(0));
  };
  process.once('SIGINT',shutdown);
  process.once('SIGTERM',shutdown);
}

import {afterEach,describe,expect,it} from 'vitest';
import WebSocket from 'ws';
import {createLocalApiServer,type LocalApiServer} from './server';

const running:LocalApiServer[]=[];

afterEach(async()=>{
  await Promise.all(running.splice(0).map(server=>server.stop()));
});

async function startServer(){
  const server=createLocalApiServer();
  running.push(server);
  const address=await server.start(0);
  return {server,address,baseUrl:`http://${address.host}:${address.port}`};
}

function openWebSocket(url:string):Promise<WebSocket> {
  return new Promise((resolve,reject)=>{
    const client=new WebSocket(url);
    client.once('open',()=>resolve(client));
    client.once('error',reject);
  });
}

function nextMessage(client:WebSocket):Promise<Record<string,unknown>> {
  return new Promise((resolve,reject)=>{
    client.once('message',data=>{
      try{resolve(JSON.parse(data.toString()) as Record<string,unknown>);}catch(error){reject(error);}
    });
    client.once('error',reject);
  });
}

async function waitForCommand(baseUrl:string,requestId:string,status:string):Promise<Record<string,unknown>> {
  for(let attempt=0;attempt<20;attempt+=1){
    const response=await fetch(`${baseUrl}/api/v1/commands/${requestId}`);
    const body=await response.json() as Record<string,unknown>;
    if(body.status===status)return body;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw new Error(`Command ${requestId} did not reach ${status}`);
}

describe('local API server',()=>{
  it('binds to IPv4 loopback and reports extension connectivity',async()=>{
    const {address,baseUrl}=await startServer();
    expect(address.host).toBe('127.0.0.1');

    const response=await fetch(`${baseUrl}/api/v1/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status:'ok',
      host:'127.0.0.1',
      extensionConnected:false,
    });
  });

  it('rejects browser origins other than Chrome extensions',async()=>{
    const {baseUrl}=await startServer();
    const response=await fetch(`${baseUrl}/api/v1/health`,{headers:{origin:'https://example.com'}});
    expect(response.status).toBe(403);
  });

  it('relays commands, records acknowledgements, and exposes player state',async()=>{
    const {address,baseUrl}=await startServer();
    const client=await openWebSocket(`ws://${address.host}:${address.port}/api/v1/extension`);

    const incoming=nextMessage(client);
    const commandResponse=await fetch(`${baseUrl}/api/v1/commands`,{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({source:'youtube',command:'toggle'}),
    });
    expect(commandResponse.status).toBe(202);
    const accepted=await commandResponse.json() as {requestId:string};
    const command=await incoming;
    expect(command).toMatchObject({
      type:'command',
      requestId:accepted.requestId,
      source:'youtube',
      command:'toggle',
    });

    client.send(JSON.stringify({
      protocolVersion:1,
      type:'command-result',
      timestamp:Date.now(),
      source:'youtube',
      requestId:accepted.requestId,
      success:true,
    }));
    const result=await waitForCommand(baseUrl,accepted.requestId,'succeeded');
    expect(result).toMatchObject({status:'succeeded'});

    client.send(JSON.stringify({
      protocolVersion:1,
      type:'player-state',
      timestamp:Date.now(),
      source:'youtube',
      connected:true,
      tabAvailable:true,
      playing:true,
      title:'Example',
      artist:'Channel',
      currentTime:10,
      duration:100,
      progress:10,
    }));

    let stateResponse:Response|undefined;
    for(let attempt=0;attempt<20;attempt+=1){
      stateResponse=await fetch(`${baseUrl}/api/v1/states/youtube`);
      if(stateResponse.status===200)break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    expect(stateResponse?.status).toBe(200);
    expect(await stateResponse?.json()).toMatchObject({title:'Example',playing:true});

    client.close();
  });

  it('rejects command creation when the extension is disconnected',async()=>{
    const {baseUrl}=await startServer();
    const response=await fetch(`${baseUrl}/api/v1/commands`,{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({source:'youtube_music',command:'next'}),
    });
    expect(response.status).toBe(503);
  });
});

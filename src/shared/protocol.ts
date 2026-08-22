import type {MediaSource} from './media-source';
import {isMediaSource} from './media-source';

export const PROTOCOL_VERSION=1 as const;
export const PLAYER_COMMANDS=['toggle','play','pause','previous','next','request-state'] as const;

export type PlayerCommand=typeof PLAYER_COMMANDS[number];

export interface BaseMessage {
  protocolVersion:1;
  type:string;
  timestamp:number;
  source:MediaSource;
}

export interface PlayerStateMessage extends BaseMessage {
  type:'player-state';
  connected:boolean;
  tabAvailable:boolean;
  playing:boolean;
  title:string;
  artist:string;
  currentTime:number;
  duration:number;
  progress:number;
}

export interface CommandMessage extends BaseMessage {
  type:'command';
  requestId:string;
  command:PlayerCommand;
}

export interface RecommendationItem {
  selectionId:string;
  queueIndex:number;
  title:string;
  artist:string;
  duration:string;
  url:string;
  thumbnailUrl:string;
}

export interface RecommendationListMessage extends BaseMessage {
  type:'recommendation-list';
  revision:number;
  items:RecommendationItem[];
}

export interface RecommendationSelectionMessage extends BaseMessage {
  type:'select-recommendation';
  requestId:string;
  revision:number;
  selectionId:string;
}

export interface CommandResultMessage extends BaseMessage {
  type:'command-result';
  requestId:string;
  success:boolean;
  error?:string;
}

function hasBaseMessage(value:unknown):value is BaseMessage {
  const message=value as Partial<BaseMessage>;
  return !!message
    &&message.protocolVersion===PROTOCOL_VERSION
    &&typeof message.type==='string'
    &&Number.isFinite(message.timestamp)
    &&isMediaSource(message.source);
}

export function isPlayerCommand(value:unknown):value is PlayerCommand {
  return typeof value==='string'&&PLAYER_COMMANDS.includes(value as PlayerCommand);
}

export function isPlayerState(value:unknown):value is PlayerStateMessage {
  if(!hasBaseMessage(value)||value.type!=='player-state')return false;
  const message=value as Partial<PlayerStateMessage>;
  return typeof message.connected==='boolean'
    &&typeof message.tabAvailable==='boolean'
    &&typeof message.playing==='boolean'
    &&typeof message.title==='string'
    &&typeof message.artist==='string'
    &&Number.isFinite(message.currentTime)
    &&Number(message.currentTime)>=0
    &&Number.isFinite(message.duration)
    &&Number(message.duration)>=0
    &&Number.isFinite(message.progress)
    &&Number(message.progress)>=0
    &&Number(message.progress)<=100;
}

export function isCommand(value:unknown):value is CommandMessage {
  if(!hasBaseMessage(value)||value.type!=='command')return false;
  const message=value as Partial<CommandMessage>;
  return typeof message.requestId==='string'
    &&message.requestId.length>0
    &&message.requestId.length<=128
    &&isPlayerCommand(message.command);
}

export function isRecommendationList(value:unknown):value is RecommendationListMessage {
  if(!hasBaseMessage(value)||value.type!=='recommendation-list')return false;
  const message=value as Partial<RecommendationListMessage>;
  return Number.isInteger(message.revision)
    &&Number(message.revision)>=0
    &&Array.isArray(message.items)
    &&message.items.length<=8
    &&message.items.every(item=>typeof item?.selectionId==='string'
      &&/^[A-Za-z0-9_-]{6,64}$/.test(item.selectionId)
      &&Number.isInteger(item.queueIndex)
      &&item.queueIndex>=0
      &&typeof item.title==='string'
      &&typeof item.artist==='string'
      &&typeof item.duration==='string'
      &&typeof item.url==='string'
      &&typeof item.thumbnailUrl==='string');
}

export function isRecommendationSelection(value:unknown):value is RecommendationSelectionMessage {
  if(!hasBaseMessage(value)||value.type!=='select-recommendation')return false;
  const message=value as Partial<RecommendationSelectionMessage>;
  return typeof message.requestId==='string'
    &&message.requestId.length>0
    &&message.requestId.length<=128
    &&Number.isInteger(message.revision)
    &&Number(message.revision)>=0
    &&typeof message.selectionId==='string'
    &&/^[A-Za-z0-9_-]{6,64}$/.test(message.selectionId);
}

export function isCommandResult(value:unknown):value is CommandResultMessage {
  if(!hasBaseMessage(value)||value.type!=='command-result')return false;
  const message=value as Partial<CommandResultMessage>;
  return typeof message.requestId==='string'
    &&message.requestId.length>0
    &&message.requestId.length<=128
    &&typeof message.success==='boolean'
    &&(message.error===undefined||typeof message.error==='string');
}

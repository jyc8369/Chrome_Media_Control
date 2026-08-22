import {describe,expect,it} from 'vitest';
import {isRecommendationList,isRecommendationSelection} from './protocol';

describe('recommendation protocol',()=>{
  it('accepts a bounded recommendation list',()=>{
    expect(isRecommendationList({
      protocolVersion:1,
      type:'recommendation-list',
      timestamp:1,
      source:'youtube',
      revision:2,
      items:[{selectionId:'abc123',queueIndex:0,title:'Video',artist:'Channel',duration:'4:20',url:'https://www.youtube.com/watch?v=abc123',thumbnailUrl:'https://i.ytimg.com/test.jpg'}],
    })).toBe(true);
  });

  it('rejects more than eight items and invalid selections',()=>{
    const item={selectionId:'abc123',queueIndex:0,title:'Video',artist:'Channel',duration:'4:20',url:'https://www.youtube.com/watch?v=abc123',thumbnailUrl:''};
    expect(isRecommendationList({protocolVersion:1,type:'recommendation-list',timestamp:1,source:'youtube',revision:1,items:Array(9).fill(item)})).toBe(false);
    expect(isRecommendationSelection({protocolVersion:1,type:'select-recommendation',timestamp:1,source:'youtube',requestId:'request',revision:1,selectionId:'bad id'})).toBe(false);
  });
});

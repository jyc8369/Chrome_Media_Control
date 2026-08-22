export function formatTime(value:number):string { if(!Number.isFinite(value)||value<0)return '0:00'; const s=Math.floor(value); return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`; }
export function progress(current:number,duration:number):number { if(!Number.isFinite(current)||!Number.isFinite(duration)||duration<=0)return 0; return Math.max(0,Math.min(100,current/duration*100)); }

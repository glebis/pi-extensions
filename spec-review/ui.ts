import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';

export type Dashboard = {
 spec?: string; round?: number; rounds?: number; status: string;
 reviewers: {id:string; kind?:string; model:string; phase:string; error?:string}[];
 report?: any; error?: string;
};
export const safe = (value: unknown) => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g,' ');
export function dashboardLines(view: Dashboard): string[] {
 const status:Record<string,string>={blocked:'Нужны действия',approved:'Проверка пройдена',stale:'Спецификация изменена'};
 return ['SPEC REVIEW',`Спецификация: ${safe(view.spec?.split('/').pop() ?? 'не выбрана')}`,
  `Раунд ${view.round ?? 0}/${view.rounds ?? '—'} · ${safe(status[view.status] ?? view.status)}`,'',
  ...view.reviewers.map(r=>`${safe(r.id)} / ${safe(r.kind ?? 'unknown')} / ${safe(r.model || 'CLI default (model unresolved)')} · ${safe(r.phase)}${r.error?` · ${safe(r.error)}`:''}`),
  ...(view.error?['',`Ошибка: ${safe(view.error)}`]:[])];
}
export function frameLines(lines:string[],width:number,theme:any):string[] {
 const inner=Math.max(0,width-4);
 const fg=(text:string)=>theme.fg?theme.fg('accent',text):text;
 const bg=(text:string)=>theme.bg?theme.bg('toolPendingBg',text):text;
 const edge=(left:string,right:string)=>bg(fg(left+'─'.repeat(Math.max(0,width-2))+right));
 if(width<4)return lines.map(l=>bg(truncateToWidth(l,Math.max(1,width))));
 return [edge('╭','╮'),...lines.map(line=>{
  const text=truncateToWidth(line,inner);
  return bg(fg('│')+' '+text+' '.repeat(Math.max(0,inner-visibleWidth(text)))+' '+fg('│'));
 }),edge('╰','╯')];
}
export async function panel(ctx:any, snapshot:()=>Dashboard, subscribe:(fn:()=>void)=>()=>void) {
 return ctx.ui.custom((tui:any,theme:any,_keys:any,done:any)=>{
  let selected=0;
  let offset=0;
  const actions=[
   {key:'g',label:'Начать с настройками по умолчанию',hint:'3 модели · до 3 раундов · нужны все 3 · только спецификация · платные вызовы'},
   {key:'n',label:'Настройки и другой набор',hint:'Спецификация, модели, контекст и лимиты'},
   {key:'f',label:'Открыть отзывы',hint:'Независимые заключения и обсуждение'},
   {key:'r',label:'Повторить сбои',hint:'Ещё один раунд; успешные отзывы сохраняются'},
   {key:'s',label:'Остановить проверку',hint:'Завершить процессы после подтверждения'},
   {key:'l',label:'Передать ведущему',hint:'Доработать спецификацию и перепроверить'},
   {key:'d',label:'Разобрать спор',hint:'Ввести решение или вопрос для ведущего'},
   {key:'v',label:'Ревьюеры и полный путь',hint:'Выбрать ревьюера: модель, статус, полная ошибка и замечания'},
   {key:'close',label:'Закрыть панель',hint:'Фоновая проверка продолжится'}
  ];
  const unavailable=(key:string) => {
   const view=snapshot();const busy=view.status==='проверка идёт';
   if((key==='n' || key==='g') && busy)return 'проверка идёт';
   if(key==='s' && !busy)return 'нет запущенной проверки';
   if(['r','l','d'].includes(key) && busy)return 'дождитесь завершения';
   if(key==='r' && !view.report?.reviews?.some((r:any)=>r.error))return 'нет сбоев';
   if(key==='f' && !view.report)return 'отчёта пока нет';
   if(['l','d'].includes(key) && !view.reviewers.length)return 'сначала настройте проверку';
   return '';
  };
  const initial=snapshot();
  const primary=initial.status==='проверка идёт'?'v':initial.report?.reviews?.some((r:any)=>r.error)?'r':initial.report?'f':'g';
  selected=actions.findIndex(a=>a.key===primary);
  const unsubscribe=subscribe(()=>tui.requestRender());
  const finish=(key:string)=>{unsubscribe();done(key);};
  const color=(kind:string,text:string)=>theme.fg?theme.fg(kind,text):text;
  return {
   render(width:number) {
    const height=Math.max(4,Math.min(34,(tui.terminal.rows ?? 24)-6));
    const view=snapshot();
    const completed=view.reviewers.filter(r=>r.phase==='готово' || r.phase==='ошибка' || r.phase==='сохранён успешный отзыв' || r.phase?.startsWith('замечания:')).length;
    const total=view.reviewers.length;
    const filled=total?Math.round(12*completed/total):0;
    const progress=`[${'█'.repeat(filled)}${'░'.repeat(12-filled)}] ${completed}/${total} завершено`;
    const info=dashboardLines(view).map(line=>line.includes('ошибка')?color('error',line):line.includes('готово')?color('success',line):line);
    info.splice(3,0,color(view.status==='проверка идёт'?'accent':'muted',progress));
    if(!view.report && view.status!=='проверка идёт')info.splice(4,0,'По умолчанию: 3 раунда · нужны все 3 · без доступа к репозиторию');
    const menuHeight=Math.min(5,actions.length,Math.max(1,height-12));
    const infoHeight=Math.max(1,height-menuHeight-4);
    offset=Math.min(offset,Math.max(0,info.length-infoHeight));
    const first=Math.min(Math.max(0,selected-menuHeight+1),actions.length-menuHeight);
    const menu=actions.slice(first,first+menuHeight).map((action,i)=>{
     const disabled=unavailable(action.key);
     const label=`${first+i===selected?'›':' '} [ ${action.label} ] (${action.key==='close'?'Esc':action.key})${disabled?` · недоступно: ${disabled}`:''}`;
     if(first+i===selected && theme.bg)return theme.bg('userMessageBg',color('accent',label));
     return disabled?color('muted',label):first+i===selected?color('accent',label):label;
    });
    const hint=unavailable(actions[selected].key) || actions[selected].hint;
    return frameLines([...info.slice(offset,offset+infoHeight),'',...menu,
     color('muted',hint),'↑↓ выбрать · Enter открыть · PgUp/PgDn статусы · Esc закрыть'],width,theme);
   },
   invalidate(){},dispose(){unsubscribe();},
   handleInput(data:string) {
    if(matchesKey(data,'escape'))return finish('close');
    if(matchesKey(data,'up') || matchesKey(data,'down') || matchesKey(data,'tab')) {
     const direction=matchesKey(data,'up')?-1:1;
     for(let i=0;i<actions.length;i++) {
      selected=(selected+direction+actions.length)%actions.length;
      if(!unavailable(actions[selected].key))break;
     }
    }
    else if(matchesKey(data,'home'))selected=0;
    else if(matchesKey(data,'end'))selected=actions.length-1;
    else if(matchesKey(data,'pageUp'))offset=Math.max(0,offset-3);
    else if(matchesKey(data,'pageDown'))offset+=3;
    else if(matchesKey(data,'enter')) {
     const action=actions[selected];
     if(!unavailable(action.key))return finish(action.key);
    } else {
     const action=actions.find(a=>a.key===data.toLowerCase());
     if(action && !unavailable(action.key))return finish(action.key);
    }
    tui.requestRender();
   }
  };
 },{overlay:true,overlayOptions:{width:'90%',maxHeight:'90%',anchor:'center'}});
}
export async function findings(ctx:any,report:any) {
 if(!report){ctx.ui.notify('Отчёта пока нет','info');return;}
 const lines=[`Вердикт: ${report.status}`,`Раунд ${report.round}/${report.limit}`];
 for(const [title,reviews] of [['Независимые отзывы',report.independent],['После обсуждения',report.reviews]] as const) {
  lines.push('',title);
  for(const r of reviews ?? []) {
   lines.push(`${r.id}: ${r.error ?? (r.ready?'готово':'нужны правки')}`);
   for(const f of r.findings ?? [])lines.push(`[${f.severity}] ${f.text}`);
  }
 }
 await textViewer(ctx,lines);
}
export async function textViewer(ctx:any,lines:string[]) {
 await ctx.ui.custom((tui:any,theme:any,_keys:any,done:any)=>{
  let offset=0;
  return {invalidate(){},render(width:number){
   const wrap=Math.max(1,width-4);
   const body=lines.flatMap(l=>wrapTextWithAnsi(safe(l),wrap));
   const height=Math.max(2,Math.min(22,(tui.terminal.rows ?? 26)-5));
   offset=Math.min(offset,Math.max(0,body.length-height));
   return frameLines(['ОТЗЫВЫ · ↑↓ PgUp/PgDn · Home/End · Esc назад',...body.slice(offset,offset+height),`Строки ${offset+1}–${Math.min(body.length,offset+height)} из ${body.length}`],width,theme);
  },handleInput(data:string){
   if(matchesKey(data,'escape'))return done(undefined);
   if(matchesKey(data,'down'))offset++;
   if(matchesKey(data,'up'))offset=Math.max(0,offset-1);
   if(matchesKey(data,'pageDown'))offset+=10;
   if(matchesKey(data,'pageUp'))offset=Math.max(0,offset-10);
   if(matchesKey(data,'home'))offset=0;
   if(matchesKey(data,'end'))offset=Number.MAX_SAFE_INTEGER;
   tui.requestRender();
  }};
 },{overlay:true,overlayOptions:{width:'95%',maxHeight:'95%'}});
}

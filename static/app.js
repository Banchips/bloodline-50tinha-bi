'use strict';
const $ = (id) => document.getElementById(id);
const safe = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const intFmt = (n) => Number(n || 0).toLocaleString('pt-BR');
const fmtDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d||'')) ? d.split('-').reverse().join('/') : (d||'—');
const fmtDateTime = (d) => d ? String(d).replace(/^(\d{4})-(\d{2})-(\d{2})[ T](.*)$/, '$3/$2/$1 $4') : '—';
function isoFromBrazilianDate(value){
 const m=/^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(value||'').trim());
 if(!m)throw new Error('Informe a data no formato DD/MM/AAAA.');
 const [,dd,mm,yyyy]=m;const d=new Date(Date.UTC(Number(yyyy),Number(mm)-1,Number(dd)));
 if(d.getUTCFullYear()!==Number(yyyy)||d.getUTCMonth()+1!==Number(mm)||d.getUTCDate()!==Number(dd))
   throw new Error('Data inválida. Confira o dia e o mês.');
 return `${yyyy}-${mm}-${dd}`;
}
const resultLabels = {V:'Vitória · 3 pts',E:'Empate · 1 pt',D:'Derrota · 0 pts'};
const state = {public:null, admin:null, season:'all', adminMode:false, loggedIn:false, editing:null, editingDeck:null, tables:[], canManageAdmins:false, admins:[], events:[], selectedEventId:null, editingEventId:null, openEvents:[],selectedSignupEventId:null,publishedRounds:[],selectedRoundEventId:null, inviteReturnTab:'events', currentPanel:null,sessionChecked:false,sessionLoading:false,playerSession:null,playerRounds:[],roundShareToken:null,playerAccounts:[]};
let toastTimer;
function toast(msg,error=false){const t=$('toast');t.textContent=msg;t.classList.toggle('error',error);t.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('visible'),4500)}
async function api(path,options={}){
  const opts={credentials:'same-origin',...options};
  if(options.body !== undefined && typeof options.body !== 'string') opts.body=JSON.stringify(options.body);
  if(opts.body){opts.headers={'Content-Type':'application/json','X-Bloodline-Request':'1',...(opts.headers||{})}}
  const r=await fetch(path,opts);
  let data;
  try{data=await r.json()}catch{throw new Error('Resposta inválida do servidor.')}
  if(!r.ok)throw new Error(data.error||'Falha na requisição.');
  return data;
}
function updateSeasonOptions(data){
  const seasons=data.seasons||[];
  const options='<option value="all">Todas as temporadas</option>'+seasons.map(s=>`<option value="${s.id}">${safe(s.name)}</option>`).join('');
  $('seasonSelect').innerHTML=options;
  if(state.season==='all' && !state.public && seasons.length)state.season=String(seasons[seasons.length-1].id);
  if(state.season!=='all' && !seasons.some(s=>String(s.id)===state.season))state.season='all';
  $('seasonSelect').value=state.season;
}
async function loadPublic(chooseDefault=false){
  try{
    const data=await api('/api/public?season='+encodeURIComponent(chooseDefault?'all':state.season));
    if(chooseDefault)updateSeasonOptions(data);
    if(chooseDefault && state.season!=='all'){
      state.public=await api('/api/public?season='+state.season);
    }else state.public=data;
    if(!chooseDefault)updateSeasonOptions(data);
    renderPublic();
  refreshPlayerForms();
  await loadOpenEvents();
  }catch(err){toast(err.message,true)}
}
// Busca consistente nos seletores de nomes/listas sem mudar os IDs já usados pelo BI.
// O <select> original continua sendo a fonte da verdade para as regras existentes.
const searchableSelectIds=new Set([
 'seasonSelect','playerStatsSeason','tSeason','tSubmitter','playerRegisterId','signupPlayer','signupTribe','signupDeck',
 'dPlayer','dTribe','deckFilterPlayer','eventSeason','eventPlayer','eventTribe','eventDeck',
 'mSeason','mPlayer','mTribe','mDeck','exSeason','importSeason','resetAdminUser'
]);
const searchableSelectClasses=['slot-player','slot-tribe','slot-deck'];
function normalizeSearch(text){return String(text||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('pt-BR')}
function initSearchableSelects(){
  document.querySelectorAll('select').forEach(select=>{
    if(select.dataset.comboReady==='1')return;
    if(!searchableSelectIds.has(select.id)&&!searchableSelectClasses.some(cls=>select.classList.contains(cls))&&select.options.length<7)return;
    select.dataset.comboReady='1';
    const wrap=document.createElement('div');wrap.className='search-combobox';
    select.before(wrap);wrap.appendChild(select);
    const input=document.createElement('input');input.type='search';input.autocomplete='off';input.className='search-combobox-input';
    input.setAttribute('aria-label','Pesquisar '+(select.closest('label')?.firstChild?.textContent?.trim()||'opções'));
    input.setAttribute('role','combobox');input.setAttribute('aria-autocomplete','list');input.setAttribute('aria-expanded','false');
    input.placeholder='Clique e digite para pesquisar...';
    const menu=document.createElement('div');menu.className='search-combobox-menu hidden';menu.setAttribute('role','listbox');
    wrap.insertBefore(input,select);wrap.appendChild(menu);
    select.classList.add('search-combobox-native');select.tabIndex=-1;
    const close=()=>{
      menu.classList.add('hidden');input.setAttribute('aria-expanded','false');
      const selected=select.selectedOptions[0];input.value=selected?.value?selected.textContent.trim():'';
    };
    function choose(value){
      select.value=value;
      select.dispatchEvent(new Event('change',{bubbles:true}));
      close();
      input.blur();
    }
    const draw=(query='')=>{
      menu.replaceChildren();
      const term=normalizeSearch(query.trim());
      const matches=Array.from(select.options).filter(o=>!o.disabled&&normalizeSearch(o.textContent).includes(term));
      for(const opt of matches.slice(0,120)){
        const item=document.createElement('button');item.type='button';item.className='search-combobox-option';item.setAttribute('role','option');
        item.textContent=opt.textContent;item.dataset.value=opt.value;
        if(opt.value===select.value)item.classList.add('selected');
        item.addEventListener('pointerdown',e=>e.preventDefault());
        item.addEventListener('click',e=>{e.preventDefault();choose(opt.value)});
        menu.appendChild(item);
      }
      if(!matches.length){const none=document.createElement('div');none.className='search-combobox-empty';none.textContent='Nenhuma opção encontrada';menu.appendChild(none)}
    };
    const open=()=>{
      if(select.disabled)return;
      menu.classList.remove('hidden');input.setAttribute('aria-expanded','true');
      draw('');
    };
    input.addEventListener('focus',()=>{open();input.select()});
    input.addEventListener('input',()=>{if(!select.disabled){menu.classList.remove('hidden');input.setAttribute('aria-expanded','true');draw(input.value)}});
    input.addEventListener('keydown',e=>{
      if(e.key==='Escape'){close();input.blur()}
      if(e.key==='ArrowDown'){e.preventDefault();if(menu.classList.contains('hidden'))open();menu.querySelector('button')?.focus()}
      if(e.key==='Enter'&&!menu.classList.contains('hidden')){e.preventDefault();const first=menu.querySelector('button');if(first)choose(first.dataset.value)}
    });
    menu.addEventListener('keydown',e=>{
      const buttons=Array.from(menu.querySelectorAll('button'));const idx=buttons.indexOf(document.activeElement);
      if(e.key==='ArrowDown'){e.preventDefault();buttons[Math.min(idx+1,buttons.length-1)]?.focus()}
      if(e.key==='ArrowUp'){e.preventDefault();idx<=0?input.focus():buttons[idx-1]?.focus()}
      if(e.key==='Escape'){e.preventDefault();close();input.focus()}
    });
    document.addEventListener('pointerdown',e=>{if(!wrap.contains(e.target))close()});
    const sync=()=>{
      input.disabled=select.disabled;
      if(document.activeElement!==input||menu.classList.contains('hidden')){
        const selected=select.selectedOptions[0];input.value=selected?.value?selected.textContent.trim():'';
      }
      if(!menu.classList.contains('hidden'))draw(document.activeElement===input?input.value:'');
    };
    select._comboSync=sync;
    select.addEventListener('change',sync);
    select.addEventListener('invalid',()=>{input.focus();open()});
    new MutationObserver(sync).observe(select,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled']});
    sync();
  });
}
function syncSearchableSelects(){initSearchableSelects();document.querySelectorAll('select.search-combobox-native').forEach(s=>s._comboSync?.())}
// Também cobre selects acrescentados dinamicamente (ex.: novas mesas e suas tribos).
let searchableSelectFrame=0;
new MutationObserver(()=>{
  if(searchableSelectFrame)return;
  searchableSelectFrame=requestAnimationFrame(()=>{searchableSelectFrame=0;initSearchableSelects()});
}).observe(document.body,{childList:true,subtree:true});

function renderPublic(){
  const d=state.public;
  if(!d)return;
  const summaries=[['Inscrições',d.summary.ranking_entries,'♙','Uma por jogador e tribo utilizada'],['Partidas',d.summary.matches,'⚔','Participações em rodadas'],['Tribos',d.summary.tribes,'♜','Utilizadas no período'],['Eventos',d.summary.events,'◎','Datas/etapas registradas'],['Pontos válidos',d.summary.points,'✦','Exclui tribos bloqueadas']];
  $('statsGrid').innerHTML=summaries.map(([name,val,ico,note])=>`<article class="stat"><span class="st-icon">${ico}</span><span class="st-label">${name.toUpperCase()}</span><strong>${intFmt(val)}</strong><div class="st-info">${note}</div></article>`).join('');
  renderRanking();renderTribes();renderMatches();renderTrend();
  $('ruleNote').innerHTML=`<strong>REGRAS DE PONTUAÇÃO</strong> · Vitória: 3 pontos · Empate: 1 ponto · Derrota: 0 ponto. ${d.summary.excluded_matches ? `<strong>${intFmt(d.summary.excluded_matches)} resultado(s)</strong> de tribos não pontuantes foram mantidos no histórico, sem somar pontos.` : ''} As tribos bloqueadas são definidas individualmente por temporada.`;
}
function renderRanking(){
  const d=state.public;if(!d)return;
  const needle=$('rankingSearch').value.trim().toLocaleLowerCase();
  // Cada linha corresponde a UMA combinação jogador + tribo.
  const ranks=d.ranking.filter(p=>(p.name+' '+p.tribe_name).toLocaleLowerCase().includes(needle));
  $('rankingRows').innerHTML=ranks.length?ranks.map(p=>`<tr data-player="${p.player_id}" data-tribe="${p.tribe_id}" tabindex="0" title="Ver perfil de ${safe(p.name)} e resultados de ${safe(p.tribe_name)}"><td><span class="pos ${p.position===1?'first':p.position===2?'second':p.position===3?'third':''}">${p.position}</span></td><td class="player"><a class="player-profile-link" href="#/player/${p.player_id}/${p.tribe_id}">${safe(p.name)}</a></td><td class="num">${intFmt(p.points)}</td><td>${intFmt(p.matches)}</td><td>${p.wins} / ${p.draws} / ${p.losses}</td><td class="num" title="${p.opw_pct===null?`OPW indisponível: ${p.opw_rounds} de ${p.opw_expected_rounds} partidas com mesa identificada`:`OPW calculado com ${p.opw_opponents} adversário(s) em ${p.opw_rounds} partida(s)`}">${p.opw_pct===null?'—':Number(p.opw_pct).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2})+'%'}</td><td><div class="tribe-tags"><span class="tag ${p.excluded_matches===p.matches?'off':''}" title="${p.matches} partida(s), ${p.points} ponto(s) válido(s)${p.excluded_matches?`, ${p.excluded_matches} sem pontuação`:''}">${safe(p.tribe_name)}</span></div></td><td class="action-chevron"><a href="#/player/${p.player_id}/${p.tribe_id}" aria-label="Abrir perfil de ${safe(p.name)}">›</a></td></tr>`).join(''):'<tr><td colspan="8" class="empty">Nenhuma combinação jogador/tribo encontrada. Cadastre os resultados na administração.</td></tr>';
  $('rankingFoot').textContent=`${ranks.length} entradas jogador/tribo · Desempate: pontos → OPW% → vitórias → partidas válidas. OPW: média dos adversários com piso de 33% (somente mesas completas). “—” indica histórico sem pareamentos suficientes.`;
  $('rankingRows').querySelectorAll('tr[data-player]').forEach(tr=>{
    const open=()=>navigateTo(`#/player/${tr.dataset.player}/${tr.dataset.tribe}`);
    tr.addEventListener('click',e=>{if(!e.target.closest('a'))open()});
    tr.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&!e.target.closest('a')){e.preventDefault();open()}});
  });
}
function showPlayer(id,tribeId=null){
  const p=state.public?.player_profiles?.find(x=>x.id===id);if(!p)return;
  const selected=state.public?.ranking.find(x=>x.player_id===id && x.tribe_id===tribeId);
  const decks=(p.decks||[]).map(d=>`<div class="detail-tribe"><span><strong>${safe(d.name)}</strong><small> · ${safe(d.tribe_name)}</small><br><small>${d.matches} partida(s) · ${d.wins} vitória(s) · ${d.points} ponto(s) válido(s)</small></span><a href="${safe(d.url)}" target="_blank" rel="noopener noreferrer" class="deck-link">Abrir decklist ↗</a></div>`).join('');
  const tribes=p.tribes.map(t=>{
    const entry=state.public.ranking.find(r=>r.player_id===id && r.tribe_id===t.id);
    return `<div class="detail-tribe"><span><strong>${safe(t.name)}</strong>${entry?` <small>· #${entry.position} no ranking</small>`:''} ${t.excluded_matches?'<small class="excluded">(há partidas sem pontuar)</small>':''}</span><span>${t.matches} partidas · ${t.wins} V / ${t.draws} E / ${t.losses} D · <strong>${t.points} pts</strong>${entry?' · OPW '+(entry.opw_pct===null?'—':Number(entry.opw_pct).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2})+'%'):''}</span></div>`;
  }).join('');
  $('detailContents').innerHTML=`<span class="kicker">${selected?`#${selected.position} NO RANKING · ${safe(selected.tribe_name)}`:'PERFIL DO JOGADOR'}</span><h2 id="detailTitle">${safe(p.name)}</h2><p class="muted-note">${safe(p.seasons.join(' · ')||'Sem partidas nesta seleção')}</p><div class="detail-stats"><div><strong>${p.points}</strong><small>PONTOS NO HISTÓRICO</small></div><div><strong>${p.matches}</strong><small>PARTIDAS TOTAIS</small></div><div><strong>${p.win_rate}%</strong><small>VITÓRIAS TOTAIS</small></div></div><p>${p.wins} vitórias · ${p.draws} empates · ${p.losses} derrotas, somando todas as tribos. <strong>O ranking não soma tribos diferentes.</strong></p><h3>Decks e decklists</h3><div class="detail-tribes">${decks||'<p class="muted-note">Nenhum deck enviado para este jogador.</p>'}</div><h3>Desempenho por tribo</h3><div class="detail-tribes">${tribes||'<p class="muted-note">Ainda sem partidas.</p>'}</div><p class="muted-note">Partidas antigas sem deck indicado são contabilizadas na tribo, mas não em um deck específico.</p>`;
  $('detailOverlay').classList.remove('hidden');
  $('closeDetail').focus();
}
function renderTribes(){
  const tribes=state.public?.top_tribes||[];
  const top=tribes.slice(0,8);const max=Math.max(...top.map(t=>t.points),1);
  const excludedNames=state.public?.excluded_tribes||[];
  $('tribeBars').innerHTML=top.length?top.map(t=>{
    const blocked=excludedNames.includes(t.name) && state.season!=='all';
    return `<div class="tribe-bar-item"><div class="tribe-bar-top"><span>${safe(t.name)} ${blocked?'<span class="zero-note">· Não pontua</span>':''}</span><span class="${blocked?'excluded':''}">${t.points} pts</span></div><progress class="tribe-progress" value="${Math.max(0,Number(t.points)||0)}" max="${max}" aria-label="Progresso de pontos de ${safe(t.name)}"></progress><div class="bar-sub">${t.matches} partida(s) · ${t.players} jogador(es)</div></div>`
  }).join(''):'<div class="empty">As tribos aparecem após o primeiro resultado.</div>';
}
// O histórico público abre compacto, exibindo todas as partidas do último dia.
// A busca consulta também dias anteriores, mesmo com o histórico recolhido.
let matchesExpanded=false;
function renderMatches(){
  const needle=normalizeSearch($('matchesSearch').value.trim());
  const all=state.public?.recent_matches||[]; // recebidos do servidor do mais recente ao mais antigo
  const latestDate=all[0]?.event_date;
  const filtered=all.filter(m=>normalizeSearch(`${m.player_name} ${m.tribe_name} ${m.event_date} ${fmtDate(m.event_date)} ${m.episode} ${m.season_name}`).includes(needle));
  const older=all.filter(m=>m.event_date!==latestDate);
  const showAll=Boolean(needle)||matchesExpanded;
  const visible=showAll?filtered:filtered.filter(m=>m.event_date===latestDate);
  const row=m=>`<tr><td>${fmtDate(m.event_date)}</td><td>${safe(m.episode||'Etapa')} / R${m.round_no}${state.season==='all'?`<br><small>${safe(m.season_name)}</small>`:''}</td><td><strong>${safe(m.player_name)}</strong></td><td>${safe(m.tribe_name)}${m.excluded?' <span class="zero-note">(sem pontos)</span>':''}</td><td><span class="result-pill result-${m.result}">${safe(resultLabels[m.result]||m.result)}</span></td><td class="${m.excluded?'excluded':''}"><strong>${m.points}</strong>${m.excluded?'<small> · bloqueada</small>':''}</td></tr>`;
  let html='';
  if(!visible.length){
    html='<tr><td class="empty" colspan="6">Nenhuma partida encontrada.</td></tr>';
  }else if(showAll&&!needle&&older.length){
    const latest=visible.filter(m=>m.event_date===latestDate);
    const earlier=visible.filter(m=>m.event_date!==latestDate);
    html=latest.map(row).join('')+`<tr class="matches-older-divider"><td colspan="6">Partidas de dias anteriores</td></tr>`+earlier.map(row).join('');
  }else html=visible.map(row).join('');
  $('matchRows').innerHTML=html;

  const actions=$('matchesHistoryActions');
  const summary=$('matchesHistorySummary');
  const button=$('matchesExpand');
  if(!all.length){actions.classList.add('hidden');return;}
  actions.classList.remove('hidden');
  if(needle){
    summary.textContent=`${filtered.length} resultado(s) encontrados em todas as datas disponíveis.`;
    button.classList.add('hidden');
  }else{
    const dayCount=all.length-older.length;
    summary.textContent=`Último dia jogado: ${fmtDate(latestDate)} · ${dayCount} resultado${dayCount===1?'':'s'}`;
    button.classList.toggle('hidden',!older.length);
    button.setAttribute('aria-expanded',String(matchesExpanded));
    button.querySelector('.matches-expand-label').textContent=matchesExpanded?'Recolher histórico':`Ver partidas anteriores (${older.length})`;
  }
}
function renderTrend(){
  const d=state.public;
  const events=d?.trend||[];
  const players=d?.ranking.slice(0,5)||[];
  if(players.length===0 || events.length===0){$('trendChart').innerHTML='<div class="empty">A evolução será exibida após o cadastro das partidas.</div>';$('trendLegend').innerHTML='';return}
  const visible=players.map(p=>({name:p.name,tribe:p.tribe_name,id:p.rank_key,values:events.map(ev=>Number(ev.points[p.rank_key]||0)),sum:p.points}));
  const width=1050,height=255,left=48,right=25,top=18,bottom=40;
  const max=Math.max(3,...visible.map(p=>p.sum));const x=i=>left+(events.length===1?(width-left-right)/2:i*(width-left-right)/(events.length-1));const y=v=>top+(height-top-bottom)*(1-v/max);
  const grid=[0,.25,.5,.75,1].map(k=>`<line x1="${left}" y1="${y(k*max)}" x2="${width-right}" y2="${y(k*max)}" stroke="#2c3850"/><text x="${left-10}" y="${y(k*max)+4}" text-anchor="end" fill="#8794aa" font-size="11">${Math.round(k*max)}</text>`).join('');
  const labels=events.map((ev,i)=>(events.length>8 && i%Math.ceil(events.length/8)!==0 && i!==events.length-1)?'':`<text x="${x(i)}" y="${height-14}" text-anchor="middle" fill="#8794aa" font-size="10">${safe(fmtDate(ev.date).slice(0,5))}</text>`).join('');
  // A cor da linha, dos pontos e da legenda vem da mesma classe CSS externa.
  // Não usar style="...": a CSP do servidor proíbe estilos inline.
  const lines=visible.map((p,j)=>`<polyline class="trend-line trend-series-${j}" points="${p.values.map((v,i)=>`${x(i)},${y(v)}`).join(' ')}" fill="none" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>${p.values.map((v,i)=>`<circle class="trend-point trend-series-${j}" cx="${x(i)}" cy="${y(v)}" r="3.5"/>`).join('')}`).join('');
  $('trendChart').innerHTML=`<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Evolução acumulada de pontos das cinco melhores combinações jogador e tribo">${grid}${labels}${lines}</svg>`;
  $('trendLegend').innerHTML=visible.map((p,i)=>`<span class="trend-legend-item"><i class="legend-dot trend-series-${i}" aria-hidden="true"></i><span>${safe(p.name)} · ${safe(p.tribe)} · <strong>${intFmt(p.sum)} pts</strong></span></span>`).join('');
}
// Navegação por fragmentos: cada tela tem link próprio, suporta botão direito,
// nova aba, histórico Voltar/Avançar e F5 sem depender de rotas adicionais no servidor.
const adminTabs = new Set(['review','events','roster','eligibility','import','accounts']);
function navigateTo(hash){
  if(window.location.hash===hash)applyRoute(true);
  else window.location.hash=hash;
}
function showPanel(name){
  const route={public:'#/ranking',admin:'#/admin/events',table:'#/my-area',playerArea:'#/my-area',decks:'#/decks',signup:'#/signup',invite:'#/invite/'+(state.selectedEventId||'')};
  navigateTo(route[name]||'#/ranking');
}
function showPanelNow(name,scroll=true){
  const previous=state.currentPanel;
  for(const [id,panel] of [['public','publicPanel'],['admin','adminPanel'],['table','tablePanel'],['decks','decksPanel'],['signup','signupPanel'],['invite','invitePanel'],['rounds','roundsPanel'],['playerArea','playerAreaPanel']]) $(panel).classList.toggle('hidden',id!==name);
  state.currentPanel=name;
  state.adminMode=name==='admin';
  if(name!=='public' || !window.location.hash.startsWith('#/player/'))$('detailOverlay').classList.add('hidden');
  if(scroll)window.scrollTo(0,0);
  if((name==='admin'||name==='invite')&&!state.sessionChecked&&!state.sessionLoading)refreshAdminSession();
  if(name==='table'&&previous!=='table'){refreshPlayerForms();loadTables();}
  if(name==='decks'&&previous!=='decks'){refreshPlayerForms();refreshPlayerSession();if(!state.sessionChecked)refreshAdminSession();renderDeckGallery();}
  if(name==='signup'&&previous!=='signup'){refreshPlayerSession();loadOpenEvents(true);}
  if(name==='rounds'&&previous!=='rounds')loadPublishedRounds(state.roundShareToken);
  if(name==='playerArea'&&previous!=='playerArea')refreshPlayerSession();
}
function applyRoute(scroll=true){
  // Compatibilidade: QR Codes/links da versão 2.2.7 usavam /?inscricao=ID.
  if(!window.location.hash){
    const legacy=Number(new URLSearchParams(window.location.search).get('inscricao'));
    if(Number.isSafeInteger(legacy)&&legacy>0){
      window.history.replaceState(null,'',window.location.pathname+'#/signup/'+legacy);
    }
  }
  const parts=(window.location.hash.replace(/^#\/?/,'')||'ranking').split('/');
  const route=parts[0];
  if(route==='player' && /^\d+$/.test(parts[1]||'')){
    showPanelNow('public',scroll);
    if(state.public){
      const tribe=/^\d+$/.test(parts[2]||'')?Number(parts[2]):null;
      showPlayer(Number(parts[1]),tribe);
    }
    return;
  }
  if(route==='admin'){
    const tab=adminTabs.has(parts[1])?parts[1]:'events';
    if(tab==='events' && /^\d+$/.test(parts[2]||''))state.selectedEventId=Number(parts[2]);
    showPanelNow('admin',scroll);
    switchAdminTab(tab,false);
    if(tab==='events' && state.events.length)renderLeagueEvents();
    return;
  }
  if(route==='invite' && /^\d+$/.test(parts[1]||'')){
    if(state.sessionChecked&&!state.loggedIn){showPanelNow('admin',scroll);return;}
    showPanelNow('invite',scroll);
    const ev=state.events.find(e=>e.id===Number(parts[1]));
    if(ev)populateInvite(ev);
    return;
  }
  if(route==='rounds'){
    const token=parts[1]||'';
    state.roundShareToken=/^[A-Za-z0-9_-]{35,120}$/.test(token)?token:null;
    showPanelNow('rounds',scroll);
    loadPublishedRounds(state.roundShareToken);
    return;
  }
  if(route==='my-area'||route==='table'){
    if(route==='table'){navigateTo('#/my-area');return;}
    showPanelNow('playerArea',scroll);
    return;
  }
  if(route==='signup'){
    if(/^\d+$/.test(parts[1]||''))state.selectedSignupEventId=Number(parts[1]);
    else state.selectedSignupEventId=null;
    showPanelNow('signup',scroll);
    if(state.public)renderSignupForm();
    return;
  }
  if(route==='decks'){showPanelNow(route,scroll);return;}
  showPanelNow('public',scroll);
}
function showAdmin(yes){showPanel(yes?'admin':'public')}
async function refreshAdminSession(){
 if(state.sessionLoading)return;
 state.sessionLoading=true;
 try{
   const d=await api('/api/session');
   state.loggedIn=d.admin;state.canManageAdmins=Boolean(d.can_manage_admins);
   refreshDeckAccess();renderDeckGallery();
   $('loginBox').classList.toggle('hidden',d.admin);
   $('adminContent').classList.toggle('hidden',!d.admin);
   $('logoutBtn').classList.toggle('hidden',!d.admin);
   $('ownerAdminSection').classList.toggle('hidden',!state.canManageAdmins);
   $('restoreDbSection').classList.toggle('hidden',!state.canManageAdmins);
   $('downloadDbExport').classList.toggle('hidden',!state.canManageAdmins);
   if(d.admin)refreshPlayerAccessRequests();
   $('adminIdentity').textContent=d.admin?`Conectado como ${d.username} · ${state.canManageAdmins?'Conta principal':'Administrador'}`:'';
   $('adminConfigMessage').textContent=d.admin_configured?'':'Conta principal não configurada. Execute o sistema pelo terminal para criar o primeiro usuário.';
   if(d.admin){await loadAdmin();await loadLeagueEvents();if(state.canManageAdmins)await loadAdminUsers()}
 }catch(err){toast(err.message,true)}
 finally{state.sessionChecked=true;state.sessionLoading=false;applyRoute(false)}
}
async function loadAdmin(){
 try{
   state.admin=await api('/api/admin?season=all');
   renderAdmin();refreshEventOptions();
 }catch(err){if(err.message.includes('administrativo')){state.loggedIn=false;refreshAdminSession()}else toast(err.message,true)}
}
async function loadAdminUsers(){
  if(!state.canManageAdmins)return;
  try{
    const data=await api('/api/admin/users');
    state.admins=data.users;
    $('adminUsersList').innerHTML=data.users.map(u=>{
      const status=u.active?'Ativo':'Desativado';
      const when=u.last_login_at?` · Último acesso: ${safe(fmtDateTime(u.last_login_at))}`:' · Ainda não acessou';
      return `<div class="manager-item admin-user-row"><span><b>${safe(u.username)}</b> <span class="account-role">${u.role==='owner'?'Principal':'Administrador'}</span><small>${status}${when}</small></span>${u.role==='owner'?'':`<div class="mini-buttons"><button type="button" data-user-toggle="${u.id}">${u.active?'Desativar':'Reativar'}</button><button type="button" class="danger" data-user-delete="${u.id}">Excluir</button></div>`}</div>`;
    }).join('')||'<p class="muted-note">Nenhum administrador encontrado.</p>';
    $('resetAdminUser').innerHTML='<option value="">Selecione um administrador...</option>'+data.users.filter(u=>u.role!=='owner').map(u=>`<option value="${u.id}">${safe(u.username)}</option>`).join('');
    $('adminUsersList').querySelectorAll('[data-user-toggle]').forEach(btn=>btn.addEventListener('click',async()=>{
      const u=state.admins.find(x=>x.id===Number(btn.dataset.userToggle));
      if(!u||!confirm(`${u.active?'Desativar':'Reativar'} o acesso de ${u.username}?`))return;
      try{await api(`/api/admin/users/${u.id}`,{method:'PUT',body:{active:!u.active}});toast('Acesso atualizado.');await loadAdminUsers()}
      catch(err){toast(err.message,true)}
    }));
    $('adminUsersList').querySelectorAll('[data-user-delete]').forEach(btn=>btn.addEventListener('click',async()=>{
      const u=state.admins.find(x=>x.id===Number(btn.dataset.userDelete));
      if(!u||u.role==='owner')return;
      const typed=prompt(`Excluir DEFINITIVAMENTE o acesso de ${u.username}?\nTodas as sessões serão encerradas.\nDigite o nome exato do usuário para confirmar:`);
      if(typed!==u.username)return;
      try{await api(`/api/admin/users/${u.id}`,{method:'DELETE',body:{}});toast('Acesso excluído permanentemente.');await loadAdminUsers()}
      catch(err){toast(err.message,true)}
    }));
  }catch(err){toast(err.message,true)}
}
function passwordsMatch(a,b){
  if(a!==b)throw new Error('As senhas de confirmação não coincidem.');
  if(a.length<10)throw new Error('Use uma senha de pelo menos 10 caracteres.');
}
function selectOptions(list,current,placeholder='Selecione...'){
 return `<option value="">${placeholder}</option>`+list.map(i=>`<option value="${i.id}" ${String(i.id)===String(current)?'selected':''}>${safe(i.name)}</option>`).join('');
}
function renderAdmin(){
 const d=state.admin;if(!d)return;
 const m=d.master;const current=state.season!=='all'?state.season:(m.seasons.at(-1)?.id||'');
 for(const id of ['mSeason','exSeason','importSeason']){
   const existing=$(id).value;
   $(id).innerHTML=selectOptions(m.seasons,existing||current,'Selecione uma temporada');
 }
 const existingP=$('mPlayer').value,existingT=$('mTribe').value;
 $('mPlayer').innerHTML=selectOptions(m.players,existingP,'Selecione um jogador');
 $('mTribe').innerHTML=selectOptions(m.tribes,existingT,'Selecione uma tribo');
 updateAdminDeckOptions();
 renderManager('seasonManager',m.seasons,'seasons');renderPlayerDirectory();renderManager('tribeManager',m.tribes,'tribes');
 renderExclusions();renderAdminMatches();renderTableReview();
}
// Pesquisa instantânea e cadastro pelo mesmo campo, sem alterar os dados originais.
function renderPlayerDirectory(){
  const all=state.admin?.master?.players||[];
  const field=$('newPlayer'),target=$('playerManager');
  if(!field||!target)return;
  const term=normalizeSearch(field.value.trim());
  const found=term?all.filter(p=>normalizeSearch(p.name).includes(term)):all;
  const duplicate=Boolean(term&&all.some(p=>normalizeSearch(p.name)===term));
  const button=$('registerPlayerButton');
  if(button){button.disabled=duplicate;button.title=duplicate?'Este jogador já está cadastrado.':'Cadastrar um novo jogador';}
  const counter=$('playerDirectoryCount');
  if(counter)counter.textContent=term?`${found.length} de ${all.length} jogador(es)`:`${all.length} jogador(es)`;
  if(found.length)renderManager('playerManager',found,'players');
  else target.innerHTML=term?'<p class="muted-note">Nenhum jogador encontrado. Se for um participante novo, clique em Cadastrar jogador.</p>':'<p class="muted-note">Nenhum jogador cadastrado.</p>';
}
function renderManager(id,items,category){
 $(id).innerHTML=items.length?items.map(item=>{
   const account=category==='players'?state.playerAccounts.find(a=>a.player_id===item.id):null;
   const recovery=account?`<details class="admin-recovery-fold"><summary>🔑 Recuperação de acesso · ${safe(account.username)} (${account.approval_status==='approved'&&account.active?'ativa':'aguardando aprovação'})</summary>
     ${account.approval_status==='approved'&&account.active?`<form class="stack-form admin-recovery-form" data-recovery-id="${item.id}"><label>Motivo da recuperação (auditoria)<input name="reason" required minlength="8" maxlength="300" placeholder="Ex.: Identidade conferida pessoalmente (não registre dados pessoais)"></label><button type="submit" class="button-outline">Gerar código temporário · 15 min</button></form>`:'<p class="muted-note">A conta precisa estar aprovada e ativa.</p>'}
     <p class="muted-note">O código pessoal antigo nunca é exibido a administradores.</p></details>`:'';
   return `<div class="manager-item manager-item-recovery"><div class="manager-identity"><span>${safe(item.name)} ${category==='seasons'?`<small>(ordem ${item.sort_order})</small>`:''}</span>${recovery}</div><div class="mini-buttons"><button type="button" data-rename-type="${category}" data-rename-id="${item.id}">Renomear</button><button type="button" class="danger" data-delete-category="${category}" data-delete-id="${item.id}">Excluir</button></div></div>`;
 }).join(''):'<p class="muted-note">Nenhum cadastro ainda.</p>';
 $(id).querySelectorAll('.admin-recovery-form').forEach(form=>form.addEventListener('submit',async e=>{
   e.preventDefault();
   const pid=Number(form.dataset.recoveryId),name=items.find(x=>x.id===pid)?.name||'jogador';
   if(!confirm(`Confirmou a identidade de ${name}? Um novo código invalidará o temporário anterior.`))return;
   const button=form.querySelector('button');button.disabled=true;
   try{
     const response=await api('/api/admin/player-recovery/temporary',{method:'POST',body:{player_id:pid,reason:form.elements.reason.value.trim()}});
     form.reset();showRecoveryCode(response.temporary_code,`Código temporário — ${name}`);await refreshRecoveryAudit();
   }catch(err){toast(err.message,true)}finally{button.disabled=false}
 }));
 $(id).querySelectorAll('button[data-rename-id]').forEach(b=>b.addEventListener('click',async()=>{
   const old=items.find(i=>i.id===Number(b.dataset.renameId));const name=prompt('Novo nome:',old.name);
   if(name===null||!name.trim()||name.trim()===old.name)return;
   try{await api(`/api/${category}/${old.id}`,{method:'PUT',body:{name:name.trim()}});toast('Cadastro atualizado.');await reloadAll()}catch(err){toast(err.message,true)}
  }));
  $(id).querySelectorAll('button[data-delete-id]').forEach(btn=>btn.addEventListener('click',async()=>{
    const item=items.find(x=>x.id===Number(btn.dataset.deleteId));if(!item)return;
    if(!confirm(`Excluir ${item.name}?\n\nO sistema impedirá a exclusão se houver resultados, inscrições, decks ou eventos vinculados.`))return;
    try{await api(`/api/${category}/${item.id}`,{method:'DELETE',body:{}});toast('Cadastro excluído.');await reloadAll();await loadLeagueEvents()}
    catch(err){toast(err.message,true)}
  }));
}
function renderExclusions(){
 const d=state.admin;if(!d)return;
 const seasonId=Number($('exSeason').value);
 const ex=new Set(d.master.exclusions.filter(e=>e.season_id===seasonId).map(e=>e.tribe_id));
 $('exCount').textContent=`${ex.size} bloqueada(s)`;
 $('exclusionList').innerHTML=d.master.tribes.length?d.master.tribes.map(t=>`<label class="exclusion-entry"><input type="checkbox" data-ex-tribe="${t.id}" ${ex.has(t.id)?'checked':''} ${!seasonId?'disabled':''}><span>${safe(t.name)}<small>${ex.has(t.id)?'Não pontua nesta temporada':'Pontuação habilitada'}</small></span></label>`).join(''):'<p class="empty">Cadastre tribos para configurar a pontuação.</p>';
 $('exclusionList').querySelectorAll('input').forEach(input=>input.addEventListener('change',async()=>{
   const old=!input.checked;
   try{await api('/api/exclusions',{method:'POST',body:{season_id:seasonId,tribe_id:Number(input.dataset.exTribe),excluded:input.checked}});toast('Regra de pontuação atualizada.');await reloadAll()}catch(err){input.checked=old;toast(err.message,true)}
 }));
}
function renderAdminMatches(){
 const needle=$('adminMatchSearch').value.trim().toLowerCase();
 const arr=(state.admin?.all_matches||[]).filter(m=>`${m.player_name} ${m.tribe_name} ${m.season_name} ${m.episode} ${m.event_date} ${fmtDate(m.event_date)}`.toLowerCase().includes(needle));
 $('adminMatchList').innerHTML=arr.length?arr.slice(0,300).map(m=>`<div class="admin-match-item"><div><strong>${safe(m.player_name)} · ${safe(m.tribe_name)} <span class="${m.excluded?'excluded':''}">(${m.points} pt)</span></strong><small>${fmtDate(m.event_date)} · ${safe(m.season_name)} · ${safe(m.episode||'Etapa')} · R${m.round_no} · ${safe(resultLabels[m.result])}</small></div><div class="mini-buttons">${m.table_id?'<span class="zero-note">Mesa #'+m.table_id+'</span>':`<button data-edit="${m.id}">Editar</button><button class="danger" data-delete="${m.id}">Excluir</button>`}</div></div>`).join(''):'<p class="muted-note">Nenhuma partida cadastrada.</p>';
 $('adminMatchList').querySelectorAll('button[data-edit]').forEach(b=>b.addEventListener('click',()=>editMatch(Number(b.dataset.edit))));
 $('adminMatchList').querySelectorAll('button[data-delete]').forEach(b=>b.addEventListener('click',()=>deleteMatch(Number(b.dataset.delete))));
}
function editMatch(id){const m=state.admin.all_matches.find(x=>x.id===id);if(!m)return;state.editing=id;
 const fields={mSeason:m.season_id,mDate:fmtDate(m.event_date),mEpisode:m.episode,mRound:m.round_no,mPlayer:m.player_id,mTribe:m.tribe_id,mResult:m.result,mDeck:m.deck_id??''};
 for(const [key,value] of Object.entries(fields)){if(key==='mDeck')continue;$(key).value=value;} updateAdminDeckOptions();$('mDeck').value=m.deck_id??'';
 $('matchFormTitle').textContent='Editar partida #'+id;$('saveMatch').textContent='Salvar alterações';$('cancelEdit').classList.remove('hidden');$('matchForm').scrollIntoView({behavior:'smooth',block:'center'});
}
function resetMatchForm(){state.editing=null;$('matchForm').reset();$('matchFormTitle').textContent='Adicionar partida';$('saveMatch').textContent='Salvar resultado';$('cancelEdit').classList.add('hidden');$('mSeason').value=state.season!=='all'?state.season:String(state.admin?.master.seasons.at(-1)?.id||'');{const now=new Date(); $('mDate').value=fmtDate(today())}}
async function deleteMatch(id){if(!confirm(`Excluir a partida #${id}? Essa ação não pode ser desfeita.`))return;try{await api(`/api/matches/${id}`,{method:'DELETE',body:{}});toast('Partida excluída.');if(state.editing===id)resetMatchForm();await reloadAll()}catch(err){toast(err.message,true)}}
async function reloadAll(){await loadPublic(false);await loadAdmin();await loadLeagueEvents()}
function switchAdminTab(tab,updateUrl=true){if(updateUrl){navigateTo('#/admin/'+tab);return;}document.querySelectorAll('.admin-tab').forEach(e=>{e.classList.toggle('active',e.dataset.adminTab===tab);if(e.dataset.adminTab===tab)e.setAttribute('aria-current','page');else e.removeAttribute('aria-current')});document.querySelectorAll('.admin-pane').forEach(e=>e.classList.toggle('hidden',e.id!=='pane-'+tab));if(tab==='roster' && state.loggedIn)refreshPlayerAccessRequests();}
async function downloadEndpoint(path,filename){try{const r=await fetch(path,{credentials:'same-origin'});if(!r.ok)throw new Error('Não autorizado ou exportação indisponível.');const blob=await r.blob();const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Arquivo exportado.')}catch(err){toast(err.message,true)}}

function today(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
function refreshPlayerForms(){
  if(!state.public)return;
  const d=state.public;
  const seasons=d.seasons||[];
  const v=$('tSeason').value;
  $('tSeason').innerHTML=selectOptions(seasons,v||(state.season!=='all'?state.season:seasons.at(-1)?.id),'Selecione a temporada');
  const saved=$('dPlayer').value, tribe=$('dTribe').value,filter=$('deckFilterPlayer').value;
  $('dPlayer').innerHTML=selectOptions(d.players||getRegisteredPlayers(),state.playerSession?.id||saved,'Escolha um jogador');
  $('dTribe').innerHTML=selectOptions(d.tribes||getRegisteredTribes(),tribe,'Escolha uma tribo');
  $('deckFilterPlayer').innerHTML='<option value="all">Todos os jogadores</option>'+getRegisteredPlayers().map(x=>`<option value="${x.id}">${safe(x.name)}</option>`).join('');
  $('deckFilterPlayer').value=filter||'all';
  updateSubmitterOptions();renderDeckGallery();updateSignupOptions();
  syncSearchableSelects();
}
function getRegisteredPlayers(){return state.admin?.master?.players||state.public?.players||[]}
function getRegisteredTribes(){return state.admin?.master?.tribes||state.public?.tribes||[]}
function createTableSlots(){
  $('tableSlots').innerHTML=Array.from({length:4},(_,i)=>`<article class="table-slot" id="tableSlot${i}" data-pos="${i}"><div class="slot-head"><span class="slot-number">${String(i+1).padStart(2,'0')}</span><strong>PLAYER ${i+1}</strong></div><label>Jogador<select class="slot-player" data-pos="${i}" required></select></label><label>Deck (opcional)<select class="slot-deck" data-pos="${i}"></select></label><label>Tribo<select class="slot-tribe" data-pos="${i}" required></select></label><label>Resultado<select class="slot-result" data-pos="${i}"><option value="D">Morreu · Derrota (0)</option><option value="V">Venceu (3)</option><option value="E">Empatou (1)</option></select></label></article>`).join('');
  document.querySelectorAll('.slot-player').forEach(el=>el.addEventListener('change',()=>{updateSlotDeck(el.dataset.pos);updateSubmitterOptions()}));
  document.querySelectorAll('.slot-deck').forEach(el=>el.addEventListener('change',()=>{const pos=el.dataset.pos;const d=state.public?.decks.find(d=>String(d.id)===el.value);if(d)document.querySelector(`.slot-tribe[data-pos="${pos}"]`).value=d.tribe_id;syncSearchableSelects()}));
  document.querySelectorAll('.slot-tribe').forEach(el=>el.addEventListener('change',()=>{const pos=el.dataset.pos;const d=document.querySelector(`.slot-deck[data-pos="${pos}"]`);const selected=state.public?.decks.find(x=>String(x.id)===d.value);if(selected && String(selected.tribe_id)!==el.value)d.value=''}));
  document.querySelector('.slot-result[data-pos="0"]').value='V';
  updateTableCount();
  initSearchableSelects();
}
function updateTableCount(){
  const count=Number($('tCount').value);
  for(let i=0;i<4;i++){
    $('tableSlot'+i).classList.toggle('hidden',i>=count);
    $('tableSlot'+i).querySelectorAll('select').forEach(sel=>sel.disabled=i>=count);
  }
  updateSubmitterOptions();
}
function updateSlotDeck(pos){
  const player=document.querySelector(`.slot-player[data-pos="${pos}"]`);
  const tribe=document.querySelector(`.slot-tribe[data-pos="${pos}"]`);
  const deck=document.querySelector(`.slot-deck[data-pos="${pos}"]`);
  if(!player||!tribe||!deck)return;
  const vtribe=tribe.value,vdeck=deck.value;
  const players=getRegisteredPlayers();const tribes=getRegisteredTribes();
  player.innerHTML=selectOptions(players,player.value,'Selecione o jogador');
  tribe.innerHTML=selectOptions(tribes,vtribe,'Selecione a tribo');
  const decks=(state.public?.decks||[]).filter(d=>String(d.player_id)===player.value);
  deck.innerHTML=selectOptions(decks,vdeck,'Sem deck cadastrado / selecionar tribo');
  if(!decks.some(d=>String(d.id)===vdeck))deck.value='';
}
function resetTable(){
  $('tableForm').reset();$('tDate').value=fmtDate(today());
  $('tSeason').value=state.season!=='all'?state.season:String(state.public?.seasons?.at(-1)?.id||'');
  $('tTable').value='1';
  createTableSlots();repopulateTableSlots();
}
function updateSubmitterOptions(){
  if(!state.public)return;
  const players=getRegisteredPlayers(),prior=$('tSubmitter').value;
  const ids=new Set(Array.from(document.querySelectorAll('.slot-player:not(:disabled)')).map(s=>Number(s.value)).filter(Boolean));
  $('tSubmitter').innerHTML=selectOptions(players.filter(p=>ids.has(p.id)),prior,'Quem está enviando?');
}
function repopulateTableSlots(){
  if(!$('tableSlots').children.length)createTableSlots();
  for(let i=0;i<4;i++)updateSlotDeck(i);
  updateTableCount();
}
async function submitTable(e){
  e.preventDefault();
  const entries=[];
  for(let i=0;i<Number($('tCount').value);i++){
    entries.push({player_id:document.querySelector(`.slot-player[data-pos="${i}"]`).value,
      tribe_id:document.querySelector(`.slot-tribe[data-pos="${i}"]`).value,
      deck_id:document.querySelector(`.slot-deck[data-pos="${i}"]`).value,
      result:document.querySelector(`.slot-result[data-pos="${i}"]`).value});
  }
  try{
    const body={season_id:$('tSeason').value,event_date:isoFromBrazilianDate($('tDate').value),episode:$('tEpisode').value.trim(),
      round_no:$('tRound').value,table_no:$('tTable').value,submitted_by:$('tSubmitter').value,entries};
    const r=await api('/api/tables',{method:'POST',body});
    toast(r.status==='approved'?'Mesa aprovada e registrada!':'Mesa #'+r.id+' enviada para aprovação.');
    resetTable();await loadPublic();if(state.loggedIn)await loadAdmin();await loadTables();
  }catch(err){toast(err.message,true)}
}
async function loadTables(){try{const d=await api('/api/tables?season='+encodeURIComponent(state.season));state.tables=d.tables;renderTableHistory()}catch(err){toast(err.message,true)}}
function renderTableHistory(){
  $('tableHistory').innerHTML=state.tables.length?state.tables.map(t=>`<div class="table-history-item"><div class="table-history-title"><strong>${safe(t.season_name)} · ${safe(t.episode)} · R${t.round_no} · Mesa ${t.table_no}</strong><small>${fmtDate(t.event_date)}</small></div><div class="table-results">${t.entries.map(e=>`<span class="mini-outcome ${e.result}">${safe(e.player_name)} <b>${e.result}</b></span>`).join('')}</div></div>`).join(''):'<p class="muted-note">Não há mesas aprovadas nesta seleção.</p>';
}
function renderTableReview(){
  const tables=state.admin?.game_tables||[];
  const pending=tables.filter(t=>t.status==='pending');
  const history=tables.filter(t=>t.status!=='pending');
  $('pendingCount').textContent=pending.length||'';
  $('pendingCount').classList.toggle('hidden',!pending.length);
  $('reviewPendingTotal').textContent=pending.length;
  $('reviewHistoryCount').textContent=history.length;
  const renderCard=t=>`<article class="review-item"><div><strong>#${t.id} · ${safe(t.season_name)} · ${safe(t.episode)} · R${t.round_no} / Mesa ${t.table_no}</strong><div class="muted-note">${fmtDate(t.event_date)} · Enviado por ${safe(t.submitter_name||'Admin')} · <span class="review-${t.status}">${t.status==='pending'?'PENDENTE':t.status==='approved'?'APROVADA':'REJEITADA'}</span></div><div class="review-entries">${t.entries.map(e=>`<span>${safe(e.player_name)} (${safe(e.tribe_name)}) · <strong>${e.result}</strong>${e.deck_name?' · '+safe(e.deck_name):''}</span>`).join('')}</div>${t.admin_note?`<small>Observação: ${safe(t.admin_note)}</small>`:''}</div><div class="mini-buttons">${t.status==='pending'?`<button data-review="${t.id}" data-status="approved">Aprovar</button><button class="danger" data-review="${t.id}" data-status="rejected">Rejeitar</button>`:`<button class="danger" data-remove-table="${t.id}">Excluir mesa</button>`}</div></article>`;
  $('tableReviewPending').innerHTML=pending.length?pending.map(renderCard).join(''):'<p class="review-empty-state">Nenhuma mesa aguardando aprovação.</p>';
  $('tableReviewHistory').innerHTML=history.length?history.slice(0,150).map(renderCard).join(''):'<p class="review-empty-state">Nenhuma mesa aprovada ou rejeitada até agora.</p>';
  $('pane-review').querySelectorAll('button[data-review]').forEach(b=>b.addEventListener('click',async()=>{
    const approved=b.dataset.status==='approved';if(!confirm(approved?'Aprovar a mesa e somar os pontos?':'Rejeitar esta mesa?'))return;
    const note=approved?'':(prompt('Motivo da rejeição (opcional):','')||'');
    try{await api('/api/tables/'+b.dataset.review,{method:'PUT',body:{status:b.dataset.status,note}});
      const reviewed=tables.find(t=>t.id===Number(b.dataset.review));
      if(approved && reviewed && state.season!=='all' && String(state.season)!==String(reviewed.season_id)){state.season=String(reviewed.season_id)}
      await reloadAll();await loadTables();
      toast(approved?'Mesa aprovada e pontos confirmados no ranking da temporada.':'Mesa rejeitada.');
    }catch(err){toast(err.message,true)}
  }));
  $('pane-review').querySelectorAll('button[data-remove-table]').forEach(b=>b.addEventListener('click',async()=>{
    if(!confirm('Excluir esta mesa e os resultados vinculados? Essa ação não pode ser desfeita.'))return;
    try{await api('/api/tables/'+b.dataset.removeTable,{method:'DELETE',body:{}});toast('Mesa excluída.');await reloadAll();await loadTables()}catch(err){toast(err.message,true)}
  }));
}
function updateAdminDeckOptions(){
  const player=$('mPlayer').value,tribe=$('mTribe').value,old=$('mDeck').value;
  const list=(state.admin?.decks||[]).filter(d=>String(d.player_id)===player && String(d.tribe_id)===tribe);
  $('mDeck').innerHTML=selectOptions(list,old,'Sem deck vinculado');
}
function deckEditorId(){return Number(state.playerSession?.id)||null}
function canManageDeck(deck){return Boolean(state.loggedIn || (deckEditorId()&&deck.player_id===deckEditorId()))}
function refreshDeckAccess(){
  const player=state.playerSession;
  const admin=state.loggedIn;
  const authorized=Boolean(player||admin);
  $('deckForm').classList.toggle('hidden',!authorized);
  $('deckAuthHint').classList.toggle('hidden',authorized);
  $('deckOwnershipHelp').classList.toggle('hidden',!authorized);
  $('dPlayerName').classList.toggle('hidden',!player);
  $('dPlayer').classList.toggle('hidden',Boolean(player));
  $('dPlayer').closest('.search-combobox')?.classList.toggle('hidden',Boolean(player));
  $('dPlayer').disabled=Boolean(player||state.editingDeck);
  if(player){
    $('dPlayer').value=String(player.id);
    $('dPlayerName').value=player.name;
  }
  if(!authorized && state.editingDeck)resetDeck();
  syncSearchableSelects();
}
function renderDeckGallery(){
  if(!$('deckGallery'))return;
  refreshDeckAccess();
  const player=$('deckFilterPlayer').value||'all';
  const arr=(state.public?.decks||[]).filter(d=>player==='all'||String(d.player_id)===player);
  $('deckGallery').innerHTML=arr.length?arr.map(d=>{
    const pn=getRegisteredPlayers().find(p=>p.id===d.player_id)?.name||'';
    const permitted=canManageDeck(d);
    return `<article class="deck-card"><div><span class="kicker">${safe(pn)} · ${safe(d.tribe_name)}</span><h3>${safe(d.name)}</h3></div><div class="deck-card-actions"><a href="${safe(d.url)}" class="deck-link" target="_blank" rel="noopener noreferrer">Abrir decklist ↗</a>${permitted?`<button data-edit-deck="${d.id}" class="button-outline">Editar meu deck</button><button data-delete-deck="${d.id}" class="button-outline danger">Excluir</button>`:''}</div></article>`
  }).join(''):'<p class="muted-note">Nenhum deck encontrado para este jogador.</p>';
  $('deckGallery').querySelectorAll('button[data-edit-deck]').forEach(b=>b.addEventListener('click',()=>editDeck(Number(b.dataset.editDeck))));
  $('deckGallery').querySelectorAll('button[data-delete-deck]').forEach(b=>b.addEventListener('click',async()=>{
    if(!confirm('Excluir esta decklist? As partidas continuarão no histórico, sem o vínculo com a lista apagada.'))return;
    try{await api('/api/decks/'+b.dataset.deleteDeck,{method:'DELETE',body:{}});toast('Deck excluído.');if(state.editingDeck===Number(b.dataset.deleteDeck))resetDeck();await loadPublic();if(state.loggedIn)await loadAdmin();}
    catch(err){toast(err.message,true)}
  }));
}
function editDeck(id){
  const d=state.public?.decks.find(x=>x.id===id);if(!d)return;
  if(!canManageDeck(d))return toast('Somente o dono do deck ou um administrador pode editá-lo.',true);
  state.editingDeck=id;
  $('dPlayer').value=String(d.player_id);
  $('dPlayerName').value=getRegisteredPlayers().find(p=>p.id===d.player_id)?.name||'';
  $('dTribe').value=String(d.tribe_id);$('dName').value=d.name;$('dUrl').value=d.url;
  $('dPlayer').disabled=true;
  $('deckFormTitle').textContent='Editar decklist · '+d.name;
  $('deckSaveBtn').textContent='Salvar mudanças';$('deckCancelBtn').classList.remove('hidden');$('deckCreated').classList.add('hidden');
  syncSearchableSelects();
  $('deckForm').scrollIntoView({behavior:'smooth',block:'start'});
}
function resetDeck(){
  state.editingDeck=null;$('deckForm').reset();
  $('dPlayer').disabled=false;
  $('deckFormTitle').textContent='Cadastrar meu deck';$('deckSaveBtn').textContent='Enviar decklist';$('deckCancelBtn').classList.add('hidden');$('deckCreated').classList.add('hidden');
  refreshDeckAccess();
}
async function submitDeck(e){
  e.preventDefault();
  if(!state.loggedIn&&!state.playerSession)return toast('Entre na sua conta antes de enviar um deck.',true);
  const body={player_id:$('dPlayer').value,tribe_id:$('dTribe').value,name:$('dName').value.trim(),url:$('dUrl').value.trim()};
  const editing=state.editingDeck;
  try{
    await api(editing?`/api/decks/${editing}`:'/api/decks',{method:editing?'PUT':'POST',body});
    resetDeck();toast(editing?'Decklist atualizada.':'Decklist cadastrada e vinculada à sua conta.');
    await loadPublic();if(state.loggedIn)await loadAdmin();
  }catch(err){toast(err.message,true)}
}
// Gestão administrativa de eventos, independente das partidas e do ranking.
function eventDetailRoute(){return /^#\/admin\/events\/\d+$/.test(window.location.hash);}
function eventSeasonValue(ev){const n=(String(ev.season_name||'').match(/\d+/)||[])[0];return n?Number(n):Number(ev.season_id||0);}
async function loadLeagueEvents(){
  if(!state.loggedIn)return;
  try{
    const data=await api('/api/admin/events');
    state.events=data.events||[];
    const match=window.location.hash.match(/^#\/admin\/events\/(\d+)$/);
    if(match)state.selectedEventId=Number(match[1]);
    if(!state.events.some(e=>e.id===state.selectedEventId))state.selectedEventId=state.events[0]?.id||null;
    renderLeagueEvents();
    if(state.canManageAdmins)loadResultGroups();
    if(window.location.hash.startsWith('#/invite/'))applyRoute(false);
  }catch(err){toast(err.message,true)}
}
function resetEventForm(){
  state.editingEventId=null;
  $('eventForm').reset();$('eventDate').value=fmtDate(today());
  $('eventSeason').value=state.season!=='all'?state.season:String(state.admin?.master?.seasons?.at(-1)?.id||'');
  $('eventFormTitle').textContent='Criar novo evento';$('eventSave').textContent='Criar evento';
  $('eventCancelEdit').classList.add('hidden');
}
function refreshEventOptions(){
  const m=state.admin?.master;
  if(!m)return;
  const oldSeason=$('eventSeason').value,oldPlayer=$('eventPlayer').value,oldTribe=$('eventTribe').value;
  $('eventSeason').innerHTML=selectOptions(m.seasons,oldSeason|| (state.season!=='all'?state.season:m.seasons.at(-1)?.id),'Selecione a season');
  $('eventPlayer').innerHTML=selectOptions(m.players,oldPlayer,'Selecione um jogador');
  $('eventTribe').innerHTML=selectOptions(m.tribes,oldTribe,'Selecione a tribo');
  updateEventAdminDecks();
}
function renderLeagueEvents(){
  const events=state.events;
  const isDetail=eventDetailRoute();
  $('eventAgendaView').classList.toggle('hidden',isDetail);
  $('eventDetailView').classList.toggle('hidden',!isDetail);
  const search=($('eventAgendaSearch')?.value||'').trim().toLocaleLowerCase();
  const dateDir=$('eventAgendaDate')?.value==='asc'?1:-1;
  const seasonDir=$('eventAgendaSeason')?.value==='asc'?1:-1;
  const primary=$('eventAgendaPrimary')?.value||'date';
  const dateCmp=(a,b)=>a.event_date.localeCompare(b.event_date)*dateDir;
  const seasonCmp=(a,b)=>(eventSeasonValue(a)-eventSeasonValue(b))*seasonDir;
  const visibleEvents=events.filter(e=>e.name.toLocaleLowerCase().includes(search))
    .sort((a,b)=>Number(Boolean(b.active_round))-Number(Boolean(a.active_round))
      || (primary==='season'?(seasonCmp(a,b)||dateCmp(a,b)):(dateCmp(a,b)||seasonCmp(a,b)))||(b.id-a.id));
  $('eventList').innerHTML=visibleEvents.length?visibleEvents.map(ev=>`<article class="event-list-item ${ev.id===state.selectedEventId?'selected':''} ${ev.active_round?'event-active':''} ${ev.ended_at?'event-closed':''}">
   <a class="event-list-select" href="#/admin/events/${ev.id}" data-event-open="${ev.id}" ${ev.id===state.selectedEventId?'aria-current="page"':''}>
    <span class="event-day">${safe(fmtDate(ev.event_date))}</span><strong>${safe(ev.name)}</strong>
    <small>${safe(ev.season_name)} · ${safe(ev.episode)} · ${ev.total_registered} inscrito(s) · ${ev.ended_at?'EVENTO ENCERRADO':ev.active_round?'● RODADA ATIVA':ev.registrations_open?'INSCRIÇÕES ABERTAS':'INSCRIÇÕES FECHADAS'}</small>
   </a><a class="event-qr-btn" href="#/invite/${ev.id}" data-event-invite="${ev.id}" title="Abrir QR Code e link de inscrição" aria-label="QR Code e link para ${safe(ev.name)}">▦ QR</a>${ev.ended_at?'':`<button class="event-edit-btn" type="button" data-event-edit="${ev.id}" aria-label="Editar evento ${safe(ev.name)}">Editar</button>`}<button class="event-delete-btn" type="button" data-event-delete="${ev.id}" aria-label="Excluir evento ${safe(ev.name)}">Excluir</button>
  </article>`).join(''):'<p class="muted-note">Nenhum evento encontrado para os filtros selecionados.</p>';

  $('eventList').querySelectorAll('[data-event-edit]').forEach(btn=>btn.addEventListener('click',()=>{
    const ev=events.find(e=>e.id===Number(btn.dataset.eventEdit));if(!ev)return;
    state.selectedEventId=ev.id;state.editingEventId=ev.id;
    $('eventDate').value=fmtDate(ev.event_date);$('eventName').value=ev.name;
    $('eventSeason').value=String(ev.season_id);$('eventEpisode').value=ev.episode;
    $('eventFormTitle').textContent='Editar evento';$('eventSave').textContent='Salvar evento';
    $('eventCancelEdit').classList.remove('hidden');navigateTo('#/admin/events');renderLeagueEvents();
    $('eventForm').scrollIntoView({behavior:'smooth',block:'start'});
  }));
  $('eventList').querySelectorAll('[data-event-delete]').forEach(btn=>btn.addEventListener('click',()=>deleteLeagueEvent(Number(btn.dataset.eventDelete))));
  renderEventRoster();
}
// O proprietário escolhe manter ou apagar as pontuações antes de excluir o evento.
async function deleteLeagueEvent(eventId){
  const ev=state.events.find(e=>e.id===eventId);if(!ev)return;
  const hasHistory=Boolean(ev.ended_at);
  let payload={}, deletedResults=false;
  if(hasHistory){
    const choice=prompt(`Excluir o evento ENCERRADO "${ev.name}"?\n\nMANTER = remove o evento da agenda mas mantém resultados e pontos.\nAPAGAR = remove também as partidas, mesas, pontos e OPW% vinculados a este EP (somente conta principal).\n\nDigite MANTER ou APAGAR. Cancelar não faz alterações:`);
    if(choice===null)return;
    const mode=choice.trim().toUpperCase();
    if(!['MANTER','APAGAR'].includes(mode))return toast('Escolha MANTER ou APAGAR. Nada foi excluído.',true);
    if(mode==='APAGAR'&&!state.canManageAdmins)return toast('Apenas a conta principal pode apagar resultados.',true);
    const confirmName=prompt(`Confirme digitando o NOME EXATO do evento: ${ev.name}`);
    if(confirmName===null)return;
    if(confirmName!==ev.name)return toast('Nome diferente. Nada foi excluído.',true);
    payload={confirm_name:confirmName};
    if(mode==='APAGAR'){
      const phrase=prompt('ATENÇÃO: pontos, partidas e OPW% serão recalculados. Isso não pode ser desfeito sem backup.\n\nAntes de continuar, baixe uma cópia do SQLite na seção Gerenciar resultados de teste.\n\nDigite APAGAR RESULTADOS para confirmar:');
      if(phrase!=='APAGAR RESULTADOS')return toast('Exclusão cancelada.',true);
      payload={...payload,delete_results:true,confirmation:phrase};deletedResults=true;
    }
  }else{
    if(!confirm(`Excluir o evento "${ev.name}" (${ev.season_name} · ${ev.episode}) e suas ${ev.total_registered} inscrição(ões)?\n\nEventos com rodadas ativas não podem ser removidos.`))return;
  }
  try{
    const data=await api(`/api/admin/events/${ev.id}`,{method:'DELETE',body:payload});
    if(state.editingEventId===ev.id)resetEventForm();
    if(state.selectedEventId===ev.id)state.selectedEventId=null;
    if(window.location.hash===`#/admin/events/${ev.id}`)navigateTo('#/admin/events');
    await loadLeagueEvents();await loadPublic();
    toast(deletedResults?`Evento e ${data.matches_removed} partidas removidos. Ranking atualizado.`:'Evento excluído. Resultados preservados.');
  }catch(err){toast(err.message,true)}
}

function renderResultGroups(groups){
  const root=$('resultGroupList');if(!root)return;
  const available=groups.filter(g=>g.can_purge);
  root.innerHTML=available.length?available.map(g=>{
    const code=`${g.season_id}|${g.event_date}|${g.episode}`;
    return `<div class="result-cleanup-row"><div><strong>${safe(g.season_name)} · ${safe(g.episode||'(sem EP)')}</strong><div class="muted-note">${fmtDate(g.event_date)} · ${safe(g.event_name)} · ${g.matches} partidas / ${g.tables} mesas</div></div><button type="button" class="event-delete-btn" data-purge-group="${safe(code)}">Apagar resultados</button></div>`;
  }).join(''):'<p class="muted-note">Nenhum resultado disponível para limpeza. Eventos ainda ativos não aparecem aqui.</p>';
  root.querySelectorAll('[data-purge-group]').forEach(btn=>btn.addEventListener('click',()=>{
    const g=available.find(i=>`${i.season_id}|${i.event_date}|${i.episode}`===btn.dataset.purgeGroup);
    if(g)purgeResultGroup(g);
  }));
}
async function loadResultGroups(){
  const section=$('resultCleanupSection');if(!section)return;
  section.classList.toggle('hidden',!state.canManageAdmins);
  if(!state.canManageAdmins)return;
  try{const d=await api('/api/admin/result-groups');renderResultGroups(d.groups||[])}
  catch(err){$('resultGroupList').textContent='Não foi possível carregar os resultados: '+err.message}
}
async function purgeResultGroup(g){
  const code=`${g.season_id}|${g.event_date}|${g.episode}`;
  if(!confirm(`LIMPEZA DEFINITIVA DE RESULTADOS\n\n${g.season_name} · ${g.episode||'(sem EP)'} · ${fmtDate(g.event_date)}\n${g.matches} partidas e ${g.tables} mesas serão excluídas.\n\nIsso inclui resultados antigos importados com esta mesma temporada, data e EP, mesmo que não tenham mesa vinculada.\n\nFez o download do backup completo?`))return;
  const phrase=prompt('Digite APAGAR RESULTADOS para confirmar a limpeza deste lote:');
  if(phrase!=='APAGAR RESULTADOS')return toast('Limpeza cancelada.',true);
  try{
    const d=await api('/api/admin/result-groups',{method:'DELETE',body:{season_id:g.season_id,event_date:g.event_date,episode:g.episode,confirm_group:code,confirmation:phrase}});
    await loadLeagueEvents();await loadPublic();
    toast(`Excluídas ${d.matches_removed} partidas e ${d.tables_removed} mesas. Ranking recalculado.`);
  }catch(err){toast(err.message,true)}
}

function renderEventRoster(){
  const ev=state.events.find(x=>x.id===state.selectedEventId);
  const detailDelete=$('eventDetailDelete');
  if(detailDelete){
    detailDelete.classList.toggle('hidden',!ev?.ended_at);
    detailDelete.onclick=ev?.ended_at?()=>deleteLeagueEvent(ev.id):null;
  }
  $('eventRosterTitle').textContent=ev?ev.name:'Lista de jogadores';
  $('eventRosterSubtitle').textContent=ev?`${fmtDate(ev.event_date)} · ${ev.season_name} · ${ev.episode}`:'Cadastre e selecione um evento para inscrever jogadores.';
  $('eventRosterContent').classList.toggle('hidden',!ev);
  $('eventRegisterForm').classList.toggle('hidden',Boolean(ev?.ended_at));
  $('eventRosterStats').innerHTML=ev?`<a class="event-roster-qr" id="eventRosterQR" href="#/invite/${ev.id}" title="Abrir convite e QR Code">▦ QR / Link</a><a class="event-roster-qr" href="#/rounds/${safe(ev.rounds_share_token)}" target="_blank" rel="noopener noreferrer" title="Link privado para as rodadas">🔗 Rodadas (link privado)</a><span>${ev.rounds.length?`Rodada ${ev.rounds.at(-1).round_no} · ${ev.rounds.at(-1).status==='finished'?'Finalizada':ev.rounds.at(-1).status==='published'?'Publicada':'Rascunho'}`:'Nenhuma rodada'}</span><span>${ev.total_registered} inscritos</span><span>${ev.total_checkin} check-ins</span><span>${ev.total_paid} pagos</span><span>${ev.total_decklists_ok} decklists OK</span>${ev.ended_at?'<span class="event-status-closed">✓ Evento encerrado</span>':`<button type="button" id="toggleEventOpen" class="event-open-switch ${ev.registrations_open?'on':''}" aria-pressed="${Boolean(ev.registrations_open)}">${ev.registrations_open?'● Inscrições abertas':'○ Abrir inscrições'}</button><button type="button" id="closeEventBtn" class="event-close-button" ${ev.rounds.length && ev.rounds.every(r=>r.status==='finished')?'':'disabled title="Finalize todas as rodadas antes de encerrar o evento"'}>Encerrar evento</button>`}`:'';
  if(ev && !ev.ended_at){
    $('toggleEventOpen').addEventListener('click',async e=>{
      const next=!Boolean(ev.registrations_open);
      if(!confirm(`${next?'Abrir':'Fechar'} as inscrições públicas para ${ev.name}?`))return;
      e.currentTarget.disabled=true;
      try{
        await api(`/api/admin/events/${ev.id}`,{method:'PUT',body:{registrations_open:next}});
        await loadLeagueEvents();await loadOpenEvents();toast(next?'Inscrições abertas.':'Inscrições encerradas.');
      }catch(err){toast(err.message,true);await loadLeagueEvents()}
    });
    $('closeEventBtn').addEventListener('click',async e=>{
      if(e.currentTarget.disabled)return;
      if(!confirm(`Encerrar o evento "${ev.name}" definitivamente?

Todas as rodadas devem estar finalizadas. O evento não aceitará inscrições nem novos pareamentos, e todo o histórico será preservado.`))return;
      e.currentTarget.disabled=true;
      try{
        await api(`/api/admin/events/${ev.id}/close`,{method:'POST',body:{}});
        await loadLeagueEvents();await loadOpenEvents();toast('Evento encerrado. Ranking e histórico preservados.');
      }catch(err){toast(err.message,true);await loadLeagueEvents()}
    });
  }
  renderEventRounds();
  if(!ev)return;
  const tribes=state.admin?.master?.tribes||[];
  $('eventRosterRows').innerHTML=ev.registrations.length?ev.registrations.map(r=>`<tr>
    <td><strong>${safe(r.player_name)}</strong>${r.dropped_after_round!==null?`<small class="event-dropped">Drop após rodada ${r.dropped_after_round}</small>`:''}${r.deck_url?`<small class="event-deck-small"><a href="${safe(r.deck_url)}" target="_blank" rel="noopener noreferrer">▤ ${safe(r.deck_name)} ↗</a></small>`:''}</td>
    <td><select class="event-tribe-select" data-event-tribe="${r.id}" aria-label="Tribo de ${safe(r.player_name)}">${tribes.map(t=>`<option value="${t.id}" ${t.id===r.tribe_id?'selected':''}>${safe(t.name)}</option>`).join('')}</select></td>
    <td><button type="button" class="event-toggle ${r.checkin?'on':''}" data-event-toggle="${r.id}" data-field="checkin" aria-pressed="${Boolean(r.checkin)}" title="${r.checkin?'Check-in confirmado':'Check-in pendente'}"><span aria-hidden="true">${r.checkin?'✓':'○'}</span><small>${r.checkin?'Feito':'Pendente'}</small></button></td>
    <td><button type="button" class="event-toggle ${r.paid?'on':''}" data-event-toggle="${r.id}" data-field="paid" aria-pressed="${Boolean(r.paid)}" title="${r.paid?'Pagamento confirmado':'Pagamento pendente'}"><span aria-hidden="true">${r.paid?'✓':'○'}</span><small>${r.paid?'Pago':'Pendente'}</small></button></td>
    <td><button type="button" class="event-toggle ${r.decklist_ok?'on':''}" data-event-toggle="${r.id}" data-field="decklist_ok" aria-pressed="${Boolean(r.decklist_ok)}" title="${r.decklist_ok?'Decklist aprovada':'Decklist ainda não aprovada'}"><span aria-hidden="true">${r.decklist_ok?'✓':'✕'}</span><small>${r.decklist_ok?'OK':'Não'}</small></button></td>
    <td><span class="muted-note">${r.has_player_access?'Conta registrada':'Cadastro próprio'}</span></td>
    <td><details class="event-actions-menu"><summary aria-label="Ações do jogador ${safe(r.player_name)}">Ações ▾</summary><div class="event-actions-dropdown">
      <button type="button" data-event-remove="${r.id}">Remover jogador do torneio</button>
      <button type="button" data-event-drop="${r.id}">${r.dropped_after_round===null?'Dropar após a rodada atual':'Reativar para próximas rodadas'}</button>
      <button type="button" data-event-warning="${r.id}">Registrar warning (${ev.warnings.filter(w=>w.player_id===r.player_id).length})</button>
      ${ev.warnings.filter(w=>w.player_id===r.player_id).map(w=>`<small class="event-warning-note">⚠ ${safe(w.note)}<br>${safe(w.admin_name||'Organização')} · ${safe(fmtDate((w.created_at||'').slice(0,10)))}</small>`).join('')}
    </div></details></td>
  </tr>`).join(''):'<tr><td class="empty" colspan="7">Nenhum jogador inscrito neste evento.</td></tr>';
  $('eventRosterRows').querySelectorAll('[data-event-toggle]').forEach(btn=>btn.addEventListener('click',async()=>{
    const registration=ev.registrations.find(x=>x.id===Number(btn.dataset.eventToggle));if(!registration)return;
    const field=btn.dataset.field;
    btn.disabled=true;
    try{
      await api(`/api/admin/events/${ev.id}/registrations/${registration.id}`,{method:'PUT',body:{[field]:!Boolean(registration[field])}});
      await loadLeagueEvents();
    }catch(err){toast(err.message,true);btn.disabled=false}
  }));
  $('eventRosterRows').querySelectorAll('[data-event-tribe]').forEach(sel=>sel.addEventListener('change',async()=>{
    const id=Number(sel.dataset.eventTribe);sel.disabled=true;
    try{await api(`/api/admin/events/${ev.id}/registrations/${id}`,{method:'PUT',body:{tribe_id:Number(sel.value)}});await loadLeagueEvents();toast('Tribo atualizada.');}
    catch(err){toast(err.message,true);await loadLeagueEvents()}
  }));
  $('eventRosterRows').querySelectorAll('[data-event-drop]').forEach(btn=>btn.addEventListener('click',async()=>{
    const r=ev.registrations.find(x=>x.id===Number(btn.dataset.eventDrop));if(!r)return;
    const drop=r.dropped_after_round===null;
    if(!confirm(`${drop?'Dropar':'Reativar'} ${r.player_name}? O drop preserva resultados já jogados e impede pareamentos futuros.`))return;
    try{await api(`/api/admin/events/${ev.id}/registrations/${r.id}/drop`,{method:'POST',body:{drop}});await loadLeagueEvents();toast(drop?'Drop registrado.':'Jogador reativado.');}
    catch(err){toast(err.message,true)}
  }));
  $('eventRosterRows').querySelectorAll('[data-event-warning]').forEach(btn=>btn.addEventListener('click',async()=>{
    const r=ev.registrations.find(x=>x.id===Number(btn.dataset.eventWarning));if(!r)return;
    const note=prompt(`Registrar warning administrativo para ${r.player_name}. Descreva o ocorrido (sem aplicar penalidade automática):`);
    if(note===null)return;
    if(!note.trim())return toast('Informe o motivo do warning.',true);
    if(!confirm('Registrar o warning no histórico da organização?'))return;
    try{await api(`/api/admin/events/${ev.id}/registrations/${r.id}/warnings`,{method:'POST',body:{note:note.trim()}});await loadLeagueEvents();toast('Warning registrado para a organização.');}
    catch(err){toast(err.message,true)}
  }));
  $('eventRosterRows').querySelectorAll('[data-event-remove]').forEach(btn=>btn.addEventListener('click',async()=>{
    const registration=ev.registrations.find(x=>x.id===Number(btn.dataset.eventRemove));
    if(!registration||!confirm(`Remover ${registration.player_name} deste evento? Isso não apaga o cadastro geral nem resultados.`))return;
    try{await api(`/api/admin/events/${ev.id}/registrations/${registration.id}`,{method:'DELETE',body:{}});await loadLeagueEvents();toast('Inscrição removida.');}
    catch(err){toast(err.message,true)}
  }));
}
// v2.2.9 — pareamentos públicos: somente rodadas publicadas, sem dados financeiros.
async function loadPublishedRounds(token=state.roundShareToken){
  if(!token){state.publishedRounds=[];renderPublishedRounds();return;}
  try{
    const out=await api('/api/events/rounds?token='+encodeURIComponent(token));
    if(state.roundShareToken!==token)return;
    state.publishedRounds=out.events||[];
    renderPublishedRounds();
  }catch(err){state.publishedRounds=[];renderPublishedRounds();toast('Link privado inválido ou expirado: '+err.message,true)}
}
function renderEventFinalStandings(event){
  const d=event.final_standings;
  if(!event.finished || !d)return '';
  const rounds=d.round_numbers||[];
  const results={V:'V',E:'E',D:'D',C:'C'};
  const rows=(d.players||[]).map(p=>{
    const isPodium=p.position===1||p.position===2||p.position===3;
    const position=p.position?(p.position+'º'):'—';
    const roundCells=rounds.map(no=>{
      const result=p.round_results?.[String(no)];
      return `<td class="event-final-round">${result?`<span class="event-final-result result-${safe(result.result)}" title="${safe(result.result==='V'?'Vitória':result.result==='E'?'Empate':result.result==='D'?'Derrota':'Resultado')}">${safe(results[result.result]||result.result)} · ${intFmt(result.points)}</span>`:'—'}</td>`;
    }).join('');
    return `<tr class="${p.position===1?'event-final-winner':''}"><td class="event-final-place">${p.position===1&&!p.tied?'🏆 ':''}${position}</td><td class="event-final-player"><strong>${safe(p.player_name)}</strong><small>${safe(p.tribe_name)}</small></td>${roundCells}<td>${p.wins} / ${p.draws} / ${p.losses}</td><td class="event-final-points">${intFmt(p.points)} pts</td><td>${p.opw_pct===null?'—':Number(p.opw_pct).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2})+'%'}</td><td><span class="event-final-status ${isPodium?'podium':''}">${safe(p.status)}</span></td></tr>`;
  }).join('');
  return `<section class="panel padded event-final-panel" aria-label="Classificação final do evento">
    <div class="round-heading"><div><span class="kicker">EVENTO ENCERRADO · RESULTADO OFICIAL</span><h2>🏆 Classificação final</h2>
    <p>${safe(event.name)} · ${safe(fmtDate(event.event_date))} · ${safe(event.episode)} · ${d.total_players} inscrito(s)</p></div>
    <div class="event-final-actions"><button id="copyEventFinalResult" class="button-primary" type="button">Copiar classificação</button><button id="copyEventFinalLink" class="button-outline" type="button">Copiar link</button></div></div>
    <div class="table-scroller"><table class="event-final-table"><thead><tr><th>#</th><th>JOGADOR / TRIBO</th>${rounds.map(n=>`<th>R${intFmt(n)}</th>`).join('')}<th>V / E / D</th><th>PONTOS</th><th>OPW%</th><th>STATUS</th></tr></thead>
    <tbody>${rows||`<tr><td colspan="${rounds.length+6}" class="empty">Nenhum jogador inscrito.</td></tr>`}</tbody></table></div>
    <p class="muted-note event-final-note">Pontuação exclusiva deste evento, calculada com mesas aprovadas e rodadas finalizadas. Desempate: pontos, OPW% do evento, vitórias válidas e partidas válidas. Empates persistentes compartilham a posição. Tribos bloqueadas não pontuam.</p>
  </section>`;
}
function renderPublishedRounds(){
  const events=state.publishedRounds;
  if(!events.length){$('roundsEventPicker').innerHTML='';$('roundsPublicContent').innerHTML='<section class="panel padded"><h2>Pareamentos privados</h2><p>Você precisa do link enviado pela organização, e as rodadas precisam estar publicadas ou finalizadas.</p></section>';return;}
  if(!events.some(e=>e.id===state.selectedRoundEventId))state.selectedRoundEventId=events[0].id;
  $('roundsEventPicker').innerHTML=events.map(e=>`<a class="event-picker-item ${state.selectedRoundEventId===e.id?'selected':''}" href="#/rounds/${safe(state.roundShareToken)}"><strong>${safe(e.name)}</strong><small>${safe(fmtDate(e.event_date))} · ${safe(e.season_name)} · ${safe(e.episode)}${e.finished?' · Encerrado':''}</small></a>`).join('');
  const event=events.find(e=>e.id===state.selectedRoundEventId);
  const roundSections=event.rounds.map(r=>`<section class="panel padded"><div class="round-heading"><div><span class="kicker">${safe(event.name)} · ${safe(event.episode)}</span><h2>Rodada ${r.round_no}</h2><p>${safe(fmtDate(event.event_date))} · ${r.tables.length} mesa(s)</p></div><span class="round-status ${r.status==='finished'?'finished':'published'}">● ${r.status==='finished'?'Finalizada':'Publicada'}</span></div><div class="pairing-grid">${r.tables.map(t=>`<article class="pairing-card"><h3>Mesa ${t.table_no}</h3>${t.players.map(p=>`<div class="pairing-person"><strong>${safe(p.player_name)}</strong><small>${safe(p.tribe_name)}</small></div>`).join('')}</article>`).join('')}</div></section>`).join('');
  $('roundsPublicContent').innerHTML=renderEventFinalStandings(event)+roundSections;
  if(event.finished&&event.final_standings){
    const d=event.final_standings;
    const text=[`🏆 BLOODLINE · ${event.name}`,`${fmtDate(event.event_date)} · ${event.episode}`,`CLASSIFICAÇÃO FINAL`,...d.players.map(p=>`${p.position?p.position+'º':'—'} ${p.player_name} (${p.tribe_name}) — ${p.points} pts · ${p.status}`),`Confira as rodadas: ${location.origin}${location.pathname}#/rounds/${state.roundShareToken}`].join('\n');
    $('copyEventFinalResult')?.addEventListener('click',()=>copyEventFinalText(text));
    $('copyEventFinalLink')?.addEventListener('click',()=>copyEventFinalText(`${location.origin}${location.pathname}#/rounds/${state.roundShareToken}`));
  }
}
async function copyEventFinalText(text){
  try{await navigator.clipboard.writeText(text);toast('Copiado! Pronto para compartilhar.');}
  catch{prompt('Copie o texto para compartilhar:',text);}
}
// Área de criação, ajustes e publicação de pareamentos pela organização.
function renderEventRounds(){
  const box=$('eventRoundsContent');if(!box)return;
  const ev=state.events.find(e=>e.id===state.selectedEventId);
  if(!ev){box.innerHTML='<p class="muted-note">Selecione um evento na agenda.</p>';return;}
  const rounds=[...ev.rounds].sort((a,b)=>a.round_no-b.round_no);
  const unfinished=rounds.find(r=>r.status!=='finished');
  const next=unfinished?.round_no||(rounds.length?rounds.at(-1).round_no+1:1);
  const eligible=ev.registrations.filter(r=>r.checkin&&r.paid&&(r.dropped_after_round===null||r.dropped_after_round>=next));
  const canGenerate=!ev.ended_at && next<=12 && (!unfinished||unfinished.status==='draft');
  box.innerHTML=`${ev.ended_at?'<div class="helper-panel">Evento encerrado: pareamentos preservados somente para consulta.</div>':''}<div class="round-controls"><div><strong>${eligible.length} jogador(es) apto(s) para a rodada ${next}</strong><p class="muted-note">Participantes com check-in e pagamento, excluindo drops. Mesas de 3 ou 4, sem bye. Rodada seguinte somente após finalizar a anterior.</p></div>
    <form id="generateRoundForm" class="round-generate-form"><label>Próxima rodada<input type="number" id="generateRoundNum" min="1" max="12" value="${next}" readonly></label>
    <label>Modo<select id="generateRoundMode"><option value="auto">Automático: True Swiss → Swiss</option><option value="true_swiss">Somente True Swiss estrito</option><option value="swiss">Swiss (pontuação próxima)</option></select></label>
    <button class="button-primary" type="submit" ${canGenerate?'':'disabled'}>${unfinished?.status==='draft'?'Regenerar rascunho':'Gerar pareamentos'}</button></form></div>
    ${!canGenerate&&!ev.ended_at?'<p class="helper-panel">Finalize a rodada publicada antes de gerar a próxima. Uma rodada terminada não pode ser modificada.</p>':''}
    <div class="round-list">${rounds.length?rounds.map(r=>{
      const finished=r.status==='finished',published=r.status==='published';
      const badge=finished?'✓ Finalizada':published?'● Publicada':'○ Rascunho';
      return `<article class="round-admin-item"><div class="round-heading"><div><h3>Rodada ${r.round_no} <span class="round-status ${published?'published':finished?'finished':'draft'}">${badge}</span></h3>
      <p>${r.tables.length} mesa(s) · ${r.tables.reduce((sum,t)=>sum+t.players.length,0)} jogador(es)</p>
      <p class="muted-note"><strong>${r.pairing_mode==='true_swiss'?'True Swiss':r.pairing_mode==='swiss'?'Swiss':'Pareamento ajustado'}</strong> — ${safe(r.pairing_note||'')}</p></div>
      <div class="round-actions">${finished?'<span class="round-status finished">Encerrada e despublicada</span>':published?
        `<a class="button-outline" href="#/rounds/${safe(ev.rounds_share_token)}" target="_blank" rel="noopener noreferrer">Abrir link privado</a><button class="button-outline" data-round-unpublish="${r.round_no}">Despublicar</button><button class="button-primary" data-round-finish="${r.round_no}" ${r.all_approved?'':'disabled title="Aguarde a aprovação de todas as mesas"'}>Finalizar rodada</button>`:
        `<button class="button-outline" data-round-publish="${r.round_no}">Publicar</button><button class="event-remove" data-round-delete="${r.round_no}">Excluir rascunho</button>`}</div></div>
      <div class="pairing-grid">${r.tables.map(t=>{
        const editable=published && !ev.ended_at && !finished && !['approved','pending'].includes(t.result_status);
        const values=t.admin_results||{};
        return `<article class="pairing-card admin-pairing-card"><h4>Mesa ${t.table_no}</h4><small class="${t.result_status==='approved'?'round-result-approved':'muted-note'}">${t.result_status==='approved'?'✓ Resultado aprovado':t.result_status==='pending'?'⏳ Aguardando aprovação':t.result_status==='rejected'?'✕ Resultado rejeitado':'○ Sem resultado aprovado'}</small>
        <form class="admin-pairing-result" data-admin-pairing="${t.id}" data-event-round="${r.round_no}" data-admin-locked="${editable?'0':'1'}">
        ${t.players.map(p=>`<div class="pairing-person admin-result-person" data-player="${p.player_id}">
           <div class="admin-pairing-ident"><strong>${safe(p.player_name)}</strong><small>${safe(p.tribe_name)}${p.deck_name?' · '+safe(p.deck_name):''}</small></div>
           <div class="admin-result-choices" role="group" aria-label="Resultado de ${safe(p.player_name)}">
           <button type="button" class="admin-result-choice choice-win" data-result="V" title="Vitória" aria-label="Vitória de ${safe(p.player_name)}" aria-pressed="false" ${editable?'':'disabled'}>★</button>
           <button type="button" class="admin-result-choice choice-loss" data-result="D" title="Derrota" aria-label="Derrota de ${safe(p.player_name)}" aria-pressed="false" ${editable?'':'disabled'}>✕</button>
           <button type="button" class="admin-result-choice choice-draw" data-result="E" title="Empate" aria-label="Empate de ${safe(p.player_name)}" aria-pressed="false" ${editable?'':'disabled'}>≈</button>
           </div></div>`).join('')}
        ${editable?'<div class="admin-pairing-controls"><p class="admin-pairing-feedback" aria-live="polite">Selecione o resultado de cada jogador.</p><div class="admin-pairing-actions"><button class="button-primary admin-pairing-submit" type="submit" disabled>Registrar resultado</button><button class="button-outline admin-pairing-clear" type="button">Limpar</button></div></div>':
          `<p class="admin-pairing-note">${t.result_status==='approved'?'Resultado contabilizado no ranking.':t.result_status==='pending'?'Envio pendente: revise-o em Mesas para aprovar.':finished?'Rodada finalizada.':published?'Mesa indisponível para lançamento.':'Publique a rodada para lançar resultados.'}</p>`}
        </form></article>`;
      }).join('')}</div>
      ${!finished&&!published&&r.tables.length>1?`<form class="round-swap" data-round-swap="${r.round_no}"><strong>Trocar jogadores entre mesas</strong><select aria-label="Jogador A" name="first" required><option value="">Primeiro jogador</option>${r.tables.flatMap(t=>t.players.map(p=>`<option value="${p.player_id}">${safe(p.player_name)} · Mesa ${t.table_no}</option>`)).join('')}</select><select name="second" aria-label="Jogador B" required><option value="">Segundo jogador</option>${r.tables.flatMap(t=>t.players.map(p=>`<option value="${p.player_id}">${safe(p.player_name)} · Mesa ${t.table_no}</option>`)).join('')}</select><button class="button-outline" type="submit">Trocar</button></form>`:''}
      </article>`}).join(''):'<p class="muted-note">Nenhuma rodada gerada neste evento.</p>'}</div>`;
  const endpoint=(n,extra='')=>`/api/admin/events/${ev.id}/rounds/${n}${extra}`;
  const submit=async(path,method,body,message)=>{try{await api(path,{method,body});await loadLeagueEvents();await loadPublishedRounds();toast(message)}catch(err){toast(err.message,true)}};
  $('generateRoundForm').addEventListener('submit',e=>{e.preventDefault();if(!canGenerate)return;
    if(!confirm(`${unfinished?'Regenerar':'Gerar'} a rodada ${next} com ${eligible.length} jogadores aptos?`))return;
    submit(endpoint(next),'POST',{mode:$('generateRoundMode').value,regenerate:Boolean(unfinished)},'Pareamento salvo como rascunho.');});
  box.querySelectorAll('[data-round-publish]').forEach(b=>b.addEventListener('click',()=>{const n=Number(b.dataset.roundPublish);if(confirm(`Publicar a rodada ${n}?`))submit(endpoint(n),'PUT',{published:true},'Rodada publicada.')}));
  box.querySelectorAll('[data-round-unpublish]').forEach(b=>b.addEventListener('click',()=>{const n=Number(b.dataset.roundUnpublish);if(confirm(`Despublicar a rodada ${n}?`))submit(endpoint(n),'PUT',{published:false},'Rodada despublicada.')}));
  box.querySelectorAll('[data-round-finish]').forEach(b=>b.addEventListener('click',()=>{const n=Number(b.dataset.roundFinish);if(confirm(`Finalizar definitivamente a rodada ${n}? Todas as mesas devem estar aprovadas. Os pareamentos sairão do link público e a próxima rodada será liberada.`))submit(endpoint(n,'/finish'),'POST',{},`Rodada ${n} finalizada. Próxima rodada liberada.`)}));
  box.querySelectorAll('[data-round-delete]').forEach(b=>b.addEventListener('click',()=>{const n=Number(b.dataset.roundDelete);if(confirm(`Excluir o rascunho ${n}?`))submit(endpoint(n),'DELETE',{},'Rascunho excluído.')}));
  box.querySelectorAll('[data-round-swap]').forEach(form=>form.addEventListener('submit',e=>{e.preventDefault();const n=Number(form.dataset.roundSwap);submit(endpoint(n,'/swap'),'POST',{player_a:Number(form.elements.first.value),player_b:Number(form.elements.second.value)},'Jogadores trocados.')}));
  // Botões V/D/E compactos por jogador, usando a mesma validação da Área do Jogador.
  box.querySelectorAll('.admin-pairing-result').forEach(form=>{
    const locked=form.dataset.adminLocked==='1';
    const round=rounds.find(r=>r.round_no===Number(form.dataset.eventRound));
    const table=round?.tables.find(t=>t.id===Number(form.dataset.adminPairing));
    if(!table)return;
    const ids=table.players.map(p=>String(p.player_id));
    const existing=table.admin_results||{};
    let choices=Object.fromEntries(ids.map(id=>[id,existing[id]||'']));
    let automatic=new Set();
    function update(){
      const valid=validatePlayerTableResults(ids.map(id=>choices[id]||''));
      form.querySelectorAll('.admin-result-person').forEach(row=>{
        const id=row.dataset.player,v=choices[id];
        row.classList.toggle('is-win',v==='V');
        row.classList.toggle('is-loss',v==='D'&&!automatic.has(id));
        row.classList.toggle('is-auto-loss',v==='D'&&automatic.has(id));
        row.classList.toggle('is-draw',v==='E');
        row.querySelectorAll('.admin-result-choice').forEach(b=>{
          const active=b.dataset.result===v;
          b.classList.toggle('selected',active);
          b.setAttribute('aria-pressed',active?'true':'false');
        });
      });
      if(!locked){
        const feedback=form.querySelector('.admin-pairing-feedback');
        feedback.textContent=valid?'✓ Resultado completo. Confira com a mesa antes de registrar.':
          ids.every(id=>!choices[id])?'Selecione o resultado de cada jogador. Uma vitória marca as demais derrotas.':
          'Preencha todos os jogadores: 1 vitória ou empate entre 2 a 4 jogadores.';
        feedback.classList.toggle('is-ready',valid);
        form.querySelector('.admin-pairing-submit').disabled=!valid;
      }
    }
    if(!locked){
      form.querySelectorAll('.admin-result-choice').forEach(button=>button.addEventListener('click',()=>{
        const id=button.closest('.admin-result-person').dataset.player;
        const chosen=button.dataset.result,previous=choices[id];
        if(previous==='V' && chosen!=='V'){
          for(const other of automatic)if(choices[other]==='D')choices[other]='';
          automatic.clear();
        }
        if(chosen==='V'){
          choices=Object.fromEntries(ids.map(pid=>[pid,pid===id?'V':'D']));
          automatic=new Set(ids.filter(pid=>pid!==id));
        }else{
          if(chosen==='E' && Object.values(choices).includes('V')){
            for(const other of automatic)if(choices[other]==='D')choices[other]='';
            for(const pid of ids)if(choices[pid]==='V')choices[pid]='';
            automatic.clear();
          }
          choices[id]=previous===chosen?'':chosen;
          automatic.delete(id);
        }
        update();
      }));
      form.querySelector('.admin-pairing-clear').addEventListener('click',()=>{
        choices=Object.fromEntries(ids.map(id=>[id,'']));automatic.clear();update();
      });
      form.addEventListener('submit',async e=>{
        e.preventDefault();
        const entries=table.players.map(p=>({player_id:p.player_id,result:choices[String(p.player_id)]||''}));
        if(!validatePlayerTableResults(entries.map(r=>r.result)))return;
        const summary=table.players.map(p=>`${p.player_name}: ${choices[String(p.player_id)]==='V'?'Vitória':choices[String(p.player_id)]==='E'?'Empate':'Derrota'}`).join('\n');
        if(!confirm(`Confirme o resultado com TODOS os jogadores da mesa antes de registrar.\n\n${summary}\n\nO lançamento administrativo será aprovado automaticamente e entrará no ranking. Confirmar?`))return;
        const send=form.querySelector('.admin-pairing-submit');send.disabled=true;
        try{
          await api(`/api/admin/events/${ev.id}/rounds/${round.round_no}/pairings/${table.id}/result`,{method:'POST',body:{entries}});
          await Promise.all([loadLeagueEvents(),loadPublic(false)]);
          toast('Resultado registrado e aprovado. Ranking atualizado.');
        }catch(err){toast(err.message,true);update();}
      });
    }
    update();
  });
  syncSearchableSelects();
}
// Inscrições públicas: o site só exibe eventos abertos e nunca libera status administrativos.
async function loadOpenEvents(redrawSignup=false){
  try{
    const data=await api('/api/events/open');
    state.openEvents=data.events||[];
    const open=state.openEvents.length>0;
    $('signupNav').classList.toggle('hidden',!open);
    $('signupNav').classList.toggle('active-glow',open);
    $('openRegistrationBanner').classList.toggle('hidden',!open);
    if(open){
      $('openRegistrationBanner').innerHTML=`<div><span class="kicker">INSCRIÇÕES ABERTAS</span><h2>${open===true && state.openEvents.length===1?safe(state.openEvents[0].name):`${state.openEvents.length} eventos com inscrições abertas`}</h2><p>Selecione seu jogador e sua tribo para participar do próximo EP.</p></div><a class="button-primary" id="goSignupBanner" href="#/signup">Inscrever-se agora →</a>`;
    }
    if(redrawSignup || !$('signupPanel').classList.contains('hidden'))renderSignupForm();
  }catch(err){toast('Não foi possível consultar eventos abertos: '+err.message,true)}
}
function openSignupEvent(id){navigateTo('#/signup/'+Number(id));}
function renderSignupForm(){
  const events=state.openEvents||[];
  const requested=Number(new URLSearchParams(window.location.search).get('inscricao'));
  if(!state.selectedSignupEventId){
    state.selectedSignupEventId=requested||events[0]?.id||null;
  }
  const current=events.find(e=>e.id===state.selectedSignupEventId);
  $('signupEventPicker').innerHTML=(events.length>1 || (events.length && !events.some(e=>e.id===state.selectedSignupEventId)))?events.map(e=>`<a href="#/signup/${e.id}" data-public-event="${e.id}" class="event-picker-item ${e.id===state.selectedSignupEventId?'selected':''}"><strong>${safe(e.name)}</strong><small>${safe(e.season_name)} · ${safe(e.episode)} · ${fmtDate(e.event_date)}</small></a>`).join(''):'';

  const enabled=Boolean(current);
  $('signupForm').classList.toggle('hidden',!enabled || !state.playerSession?.player);
  $('signupAccountNotice').innerHTML=state.playerSession?.player?'Você está entrando como <strong>'+safe(state.playerSession.name)+'</strong>. Sua inscrição ficará vinculada automaticamente a essa conta.':'Para se inscrever, <a href="#/my-area">entre na conta ou cadastre seu usuário</a> primeiro.';
  $('signupEventTitle').textContent=current?current.name:'Inscrições encerradas';
  $('signupEventInfo').textContent=current?`${current.season_name} · ${current.episode} · ${fmtDate(current.event_date)}`:'Este evento não está com inscrições abertas. Consulte a organização ou selecione outro EP disponível.';
  if(current){$('signupEventName').value=current.name;updateSignupOptions();}
}
function updateSignupOptions(){
  const m=state.public;
  if(!m)return;
  const player=String(state.playerSession?.id||''),tribe=$('signupTribe').value;
  $('signupPlayer').innerHTML=selectOptions((m.players||[]).filter(p=>p.id===Number(player)),player,'Entre na sua conta');
  $('signupTribe').innerHTML=selectOptions(m.tribes||[],tribe,'Selecione a tribo');
  updateSignupDecks();
}
function updateSignupDecks(){
  const pid=Number($('signupPlayer').value),tid=Number($('signupTribe').value);
  const sel=$('signupDeck'),old=sel.value;
  const decks=(state.public?.decks||[]).filter(d=>d.player_id===pid && (!tid || d.tribe_id===tid));
  sel.innerHTML='<option value="">Sem decklist vinculada</option>'+decks.map(d=>`<option value="${d.id}">${safe(d.name)} (${safe(d.tribe_name)})</option>`).join('');
  if(decks.some(d=>String(d.id)===old))sel.value=old;
  updateSignupDeckHint();
}
function updateSignupDeckHint(){
  const d=state.public?.decks?.find(x=>String(x.id)===$('signupDeck').value);
  $('signupDeckInfo').innerHTML=d?`Deck selecionado: <a class="deck-link" target="_blank" rel="noopener noreferrer" href="${safe(d.url)}">${safe(d.name)} ↗</a>`:'Não tem deck cadastrado? Pode enviar a inscrição sem decklist.';
}
async function submitSignup(e){
  e.preventDefault();
  const ev=state.openEvents.find(x=>x.id===state.selectedSignupEventId);
  if(!ev)return toast('Evento fechado. Selecione um evento disponível.',true);
  const btn=$('signupSubmit');btn.disabled=true;
  $('signupMessage').textContent='Enviando inscrição...';
  try{
    await api('/api/events/register',{method:'POST',body:{event_id:ev.id,tribe_id:Number($('signupTribe').value),deck_id:$('signupDeck').value||null}});
    $('signupMessage').textContent=`✓ Inscrição recebida para ${ev.name}! Procure a organização para confirmar check-in, pagamento e aprovação da decklist.`;
    toast('Inscrição enviada com sucesso!');
    $('signupTribe').value='';updateSignupDecks();await loadOpenEvents();
    toast('Inscrição recebida. Você já pode usar sua própria conta para acessar a mesa.');
    navigateTo('#/my-area');
  }catch(err){ $('signupMessage').textContent='Não foi possível inscrever: '+err.message;toast(err.message,true); }
  finally{btn.disabled=false}
}
function updateEventAdminDecks(){
  const pid=Number($('eventPlayer').value),tid=Number($('eventTribe').value);
  const sel=$('eventDeck'),old=sel.value;
  const decks=(state.public?.decks||[]).filter(d=>d.player_id===pid && (!tid || d.tribe_id===tid));
  sel.innerHTML='<option value="">Sem decklist</option>'+decks.map(d=>`<option value="${d.id}">${safe(d.name)} (${safe(d.tribe_name)})</option>`).join('');
  if(decks.some(d=>String(d.id)===old))sel.value=old;
}
function showInvite(ev){
  if(!state.loggedIn)return toast('Acesso administrativo necessário.',true);
  navigateTo('#/invite/'+ev.id);
}
function populateInvite(ev){
  const link=window.location.origin+'/?inscricao='+encodeURIComponent(ev.id);
  $('inviteBack').href='#/admin/events/'+ev.id;
  $('openInviteLink').href=link;
  $('inviteEventTitle').textContent=ev.name;
  $('inviteEventInfo').textContent=`${ev.season_name} · ${ev.episode} · ${fmtDate(ev.event_date)}`;
  $('inviteEventStatus').textContent=ev.registrations_open?'● Inscrições abertas':'○ Inscrições fechadas — abra as inscrições no painel para permitir envios.';
  $('inviteLink').value=link;
  $('inviteQR').src=`/api/admin/events/${ev.id}/qrcode.svg`;
}
// Painel pessoal: estatísticas oficiais por temporada e envio assistido da mesa.
async function refreshPlayerSession(){
  try{
    const current=await api('/api/player/session');state.playerSession=current.player?current:null;
    refreshDeckAccess();renderDeckGallery();
    $('playerLoginWrap').classList.toggle('hidden',Boolean(current.player));
    $('playerDashboard').classList.toggle('hidden',!current.player);
    $('playerRegisterId').innerHTML='<option value="">Sou novo na liga</option>'+getRegisteredPlayers().map(p=>`<option value="${p.id}">${safe(p.name)}</option>`).join('');
    $('playerRegisterNewNameWrap').classList.toggle('hidden',Boolean($('playerRegisterId').value));
    if(state.currentPanel==='signup')renderSignupForm();
    if(current.player){
      $('playerIdentity').textContent=current.name;
      $('playerNewUsername').value=current.username||'';
      $('playerNewDisplayName').value=current.name||'';
      $('recoverySetupHint').classList.toggle('hidden',Boolean(current.has_recovery_code));
      await Promise.all([refreshPlayerRounds(),refreshPlayerResults()]);
    }else{
      $('recoverySetupHint').classList.add('hidden');
      state.playerRounds=[];state.playerStatsSeason='all';
      $('playerRoundsList').replaceChildren();$('playerRoundsSection').classList.add('hidden');
      $('playerStatsContent').innerHTML='<p class="muted-note">Entre para consultar suas estatísticas.</p>';
    }
  }catch(err){toast(err.message,true)}
}
async function refreshPlayerRounds(){
  if(!state.playerSession)return;
  try{const data=await api('/api/player/my-rounds');state.playerRounds=data.rounds||[];renderMyRounds();}
  catch(err){toast(err.message,true)}
}
function validatePlayerTableResults(values){
  if(values.some(v=>!['V','D','E'].includes(v)))return false;
  const wins=values.filter(v=>v==='V').length;
  const draws=values.filter(v=>v==='E').length;
  return (wins===1 && draws===0) || (wins===0 && draws>=2);
}
function renderMyRounds(){
  const arr=state.playerRounds;
  $('playerRoundsSection').classList.toggle('hidden',arr.length===0);
  $('playerRoundsList').innerHTML=arr.map(round=>{
    const status=round.status==='pending'?'Enviado · aguardando aprovação':round.status==='approved'?'Resultado aprovado':round.status==='rejected'?'Resultado rejeitado · pode reenviar':'Aguardando lançamento';
    const locked=['pending','approved'].includes(round.status);
    const existing=round.submitted_results||{};
    return `<section class="panel padded player-round-item"><span class="kicker">${safe(round.season_name)} · ${safe(round.episode)} · ${fmtDate(round.event_date)}</span><div class="round-heading"><div><h3>${safe(round.event_name)} · Rodada ${round.round_no} · Mesa ${round.table_no}</h3><p>Confira o resultado com todos os participantes antes de enviá-lo.</p></div><span class="round-status ${locked?'published':'draft'}">${locked?'●':'○'} ${status}</span></div>
      <form class="player-result-form" data-pairing="${round.pairing_id}" data-locked="${locked?'1':'0'}">
      <div class="player-result-grid">${round.players.map(p=>`<div class="player-result-person ${p.player_id===state.playerSession.id?'myself':''}" data-player="${p.player_id}">
        <div class="player-seat-title"><strong>${safe(p.player_name)}${p.player_id===state.playerSession.id?' <span class="player-you">Você</span>':''}</strong><span class="player-seat-tribe">${safe(p.tribe_name)}</span></div>
        <div class="player-seat-state" aria-live="polite">Aguardando resultado</div>
        <div class="player-seat-choices" role="group" aria-label="Resultado de ${safe(p.player_name)}">
          <button type="button" class="player-choice choice-win" data-result="V" aria-label="Vitória de ${safe(p.player_name)}" aria-pressed="false" title="Vitória" ${locked?'disabled':''}><span aria-hidden="true">★</span><small>Vitória</small></button>
          <button type="button" class="player-choice choice-loss" data-result="D" aria-label="Derrota de ${safe(p.player_name)}" aria-pressed="false" title="Derrota" ${locked?'disabled':''}><span aria-hidden="true">✕</span><small>Derrota</small></button>
          <button type="button" class="player-choice choice-draw" data-result="E" aria-label="Empate de ${safe(p.player_name)}" aria-pressed="false" title="Empate" ${locked?'disabled':''}><span aria-hidden="true">≈</span><small>Empate</small></button>
        </div></div>`).join('')}</div>
      <p class="player-table-feedback" role="status" aria-live="polite"></p>
      <div class="form-actions player-result-actions">${locked?'<span class="muted-note">Este resultado já foi enviado. Aguarde a organização.</span>':`<button class="button-primary player-send-result" type="submit" disabled>Enviar resultado</button><button class="button-outline player-clear-result" type="button">Limpar</button>`}</div>
      </form></section>`;
  }).join('');
  $('playerRoundsList').querySelectorAll('.player-result-form').forEach(form=>{
    const locked=form.dataset.locked==='1';
    const round=arr.find(r=>String(r.pairing_id)===form.dataset.pairing);
    const ids=round.players.map(p=>String(p.player_id));
    let choices=Object.fromEntries(ids.map(id=>[id,(locked?(round.submitted_results||{})[id]:'')||'']));
    let automatic=new Set();
    function sync(){
      const values=ids.map(id=>choices[id]);
      const valid=validatePlayerTableResults(values);
      form.querySelectorAll('.player-result-person').forEach(card=>{
        const id=card.dataset.player,result=choices[id]||'';
        card.classList.toggle('is-win',result==='V');
        card.classList.toggle('is-loss',result==='D'&&!automatic.has(id));
        card.classList.toggle('is-auto-loss',result==='D'&&automatic.has(id));
        card.classList.toggle('is-draw',result==='E');
        card.classList.toggle('is-unset',!result);
        card.querySelector('.player-seat-state').textContent=result==='V'?'Vitória · 3 pontos':result==='D'?'Derrota · 0 pontos':result==='E'?'Empate · 1 ponto':'Aguardando resultado';
        card.querySelectorAll('.player-choice').forEach(button=>{
          const selected=button.dataset.result===result;
          button.classList.toggle('selected',selected);
          button.setAttribute('aria-pressed',selected?'true':'false');
        });
      });
      const feedback=form.querySelector('.player-table-feedback');
      if(locked){feedback.textContent=round.status==='approved'?'Resultado confirmado e pontuado.':'Resultado aguardando aprovação da organização.';}
      else if(valid){feedback.textContent='✓ Mesa completa. Confira as marcações com todos e envie para aprovação.';}
      else if(values.every(v=>!v)){feedback.textContent='Selecione vitória, derrota ou empate para começar. Uma vitória completa automaticamente as demais derrotas.';}
      else if(values.some(v=>!v)){feedback.textContent='Faltam resultados. Marque todos os participantes para concluir.';}
      else{feedback.textContent='Resultado inconsistente: escolha um único vencedor ou pelo menos dois empatados (os demais derrotados).';}
      feedback.classList.toggle('is-ready',valid&&!locked);
      const send=form.querySelector('.player-send-result');if(send)send.disabled=!valid;
    }
    form.querySelectorAll('.player-choice').forEach(button=>button.addEventListener('click',()=>{
      if(locked)return;
      const id=button.closest('.player-result-person').dataset.player;
      const chosen=button.dataset.result;
      const previous=choices[id];
      // Ao desfazer uma vitória, elimine as derrotas preenchidas automaticamente.
      if(previous==='V' && chosen!=='V'){
        for(const autoId of automatic)if(choices[autoId]==='D')choices[autoId]='';
        automatic.clear();
      }
      if(chosen==='V'){
        choices=Object.fromEntries(ids.map(pid=>[pid,pid===id?'V':'D']));
        automatic=new Set(ids.filter(pid=>pid!==id));
      }else{
        if(chosen==='E' && Object.values(choices).includes('V')){
          for(const autoId of automatic)if(choices[autoId]==='D')choices[autoId]='';
          for(const pid of ids)if(choices[pid]==='V')choices[pid]='';
          automatic.clear();
        }
        choices[id]=previous===chosen?'':chosen;
        automatic.delete(id);
      }
      sync();
    }));
    form.querySelector('.player-clear-result')?.addEventListener('click',()=>{
      choices=Object.fromEntries(ids.map(id=>[id,'']));automatic.clear();sync();
    });
    form.addEventListener('submit',async e=>{
      e.preventDefault();
      if(locked)return;
      const entries=round.players.map(p=>({player_id:p.player_id,result:choices[String(p.player_id)]||''}));
      if(!validatePlayerTableResults(entries.map(p=>p.result)))return toast('Conclua uma combinação válida de vitória, derrota ou empate.',true);
      const summary=round.players.map(p=>`${p.player_name}: ${choices[String(p.player_id)]==='V'?'Vitória':choices[String(p.player_id)]==='E'?'Empate':'Derrota'}`).join('\n');
      if(!confirm(`Confirme o resultado com TODOS os jogadores da mesa antes de enviar.\n\n${summary}\n\nDepois do envio, o registro ficará aguardando aprovação da organização. Deseja continuar?`))return;
      const send=form.querySelector('.player-send-result');send.disabled=true;
      try{
        await api(`/api/player/pairings/${Number(form.dataset.pairing)}/result`,{method:'POST',body:{entries}});
        toast('Resultado enviado. Aguardando aprovação da organização.');
        await Promise.all([refreshPlayerRounds(),refreshPlayerResults()]);
      }catch(err){toast(err.message,true);sync();}
    });
    sync();
  });
}
async function refreshPlayerResults(){
  if(!state.playerSession)return;
  try{
    const selected=state.playerStatsSeason||'all';
    const data=await api('/api/player/my-results?season='+encodeURIComponent(selected));
    state.playerStatsSeason=String(data.season_id);
    const picker=$('playerStatsSeason');
    picker.innerHTML='<option value="all">Todas as temporadas</option>'+data.seasons.map(s=>`<option value="${s.id}">${safe(s.name)}</option>`).join('');
    picker.value=state.playerStatsSeason;
    picker._comboSync?.();
    renderPlayerResults(data);
  }catch(err){
    // Quando a temporada deixou de ser válida, retorne para o histórico completo.
    if(state.playerStatsSeason&&state.playerStatsSeason!=='all'){
      state.playerStatsSeason='all';return refreshPlayerResults();
    }
    $('playerStatsContent').innerHTML=`<p class="muted-note">Não foi possível carregar os resultados: ${safe(err.message)}</p>`;
  }
}
function renderPlayerResults(data){
  const p=data.profile,deckList=(p.decks||[]).filter(d=>data.season_id==='all'||d.matches>0);
  const stats=[['Pontos válidos',p.points],['Partidas',p.matches],['Vitórias',p.wins],['Empates',p.draws],['Derrotas',p.losses],['Win rate',Number(p.win_rate||0).toLocaleString('pt-BR',{maximumFractionDigits:1})+'%']];
  const tribes=(p.tribes||[]).map(t=>{
    const r=(data.ranking_entries||[]).find(x=>x.tribe_id===t.id);
    const wr=t.matches?((t.wins/t.matches)*100).toLocaleString('pt-BR',{maximumFractionDigits:1})+'%':'—';
    return `<tr><td><strong>${safe(t.name)}</strong></td><td>${t.points}</td><td>${t.matches}</td><td>${t.wins} / ${t.draws} / ${t.losses}</td><td>${wr}</td><td>${r?.opw_pct===null||r?.opw_pct===undefined?'—':Number(r.opw_pct).toLocaleString('pt-BR',{maximumFractionDigits:2})+'%'}</td></tr>`;
  }).join('');
  const decks=deckList.map(d=>{
    const wr=d.matches?((d.wins/d.matches)*100).toLocaleString('pt-BR',{maximumFractionDigits:1})+'%':'—';
    return `<tr><td><a href="${safe(d.url)}" target="_blank" rel="noopener noreferrer">${safe(d.name)} ↗</a><small class="player-stat-secondary">${safe(d.tribe_name)}</small></td><td>${d.points}</td><td>${d.matches}</td><td>${d.wins} / ${d.draws} / ${d.losses}</td><td>${wr}</td></tr>`;
  }).join('');
  // A Área do Jogador segue o Histórico público: último dia visível e demais datas recolhidas.
  // A API já entrega os jogos ordenados por data decrescente, respeitando a temporada filtrada.
  const matches=data.recent_matches||[];
  const latestDate=matches[0]?.event_date;
  const latestMatches=matches.filter(m=>m.event_date===latestDate);
  const olderMatches=matches.filter(m=>m.event_date!==latestDate);
  const historyRows=items=>items.map(m=>`<tr><td>${fmtDate(m.event_date)}</td><td>${safe(m.season_name)} · ${safe(m.episode)} · R${m.round_no}</td><td>${safe(m.tribe_name)}${m.deck_name?`<small class="player-stat-secondary">${safe(m.deck_name)}</small>`:''}</td><td><span class="result-pill result-${m.result}">${safe(resultLabels[m.result]||m.result)}</span></td><td>${m.points}${m.excluded?' <small class="zero-note">(tribo não pontua)</small>':''}</td></tr>`).join('');
  const historyHead='<thead><tr><th>Data</th><th>Evento</th><th>Tribo / Deck</th><th>Resultado</th><th>Pontos</th></tr></thead>';
  const latestHistory=historyRows(latestMatches);
  const olderHistory=historyRows(olderMatches);
  $('playerStatsContent').innerHTML=`<div class="player-stats-grid">${stats.map(([name,value])=>`<div class="player-stat-tile"><span>${name}</span><strong>${value}</strong></div>`).join('')}</div>
    <div class="player-stat-group"><h3>Desempenho por tribo</h3><div class="player-table-scroll"><table class="player-stat-table"><thead><tr><th>Tribo</th><th>Pontos</th><th>Partidas</th><th>V / E / D</th><th>Win rate</th><th>OPW%</th></tr></thead><tbody>${tribes||'<tr><td colspan="6" class="muted-note">Nenhuma partida registrada nesta seleção.</td></tr>'}</tbody></table></div></div>
    <div class="player-stat-group"><h3>Decks utilizados</h3><div class="player-table-scroll"><table class="player-stat-table"><thead><tr><th>Deck / Tribo</th><th>Pontos</th><th>Partidas</th><th>V / E / D</th><th>Win rate</th></tr></thead><tbody>${decks||'<tr><td colspan="5" class="muted-note">Nenhum deck vinculado a partidas nesta seleção. Partidas sem deck ainda contam na tribo.</td></tr>'}</tbody></table></div></div>
    <div class="player-stat-group player-history-group"><h3>Histórico recente</h3>
      ${latestDate?`<p class="player-history-date-note">Último dia jogado: <strong>${fmtDate(latestDate)}</strong> · ${latestMatches.length} resultado${latestMatches.length===1?'':'s'}</p>`:''}
      <div class="player-table-scroll"><table class="player-stat-table">${historyHead}<tbody>${latestHistory||'<tr><td colspan="5" class="muted-note">Nenhum resultado aprovado nesta seleção.</td></tr>'}</tbody></table></div>
      ${olderMatches.length?`<details class="player-history-older"><summary class="player-history-older-trigger"><span>Ver partidas anteriores <small>(${olderMatches.length})</small></span><span class="player-history-chevron" aria-hidden="true">⌄</span></summary><div class="player-history-older-content"><p class="player-history-older-heading">Partidas de dias anteriores</p><div class="player-table-scroll"><table class="player-stat-table">${historyHead}<tbody>${olderHistory}</tbody></table></div></div></details>`:''}
      <p class="muted-note player-history-footnote">Exibindo até 60 participações recentes. Tribos que não pontuam continuam no histórico, com zero ponto válido.</p>
    </div>`;
}
function showRecoveryCode(code,title){
  const modal=$('recoveryCodeOverlay');
  $('recoveryCodeTitle').textContent=title||'Seu código de recuperação';
  $('recoveryCodeDisplay').textContent=String(code);
  modal.classList.remove('hidden');
  $('copyRecoveryCode').focus();
}
function closeRecoveryCode(){
  $('recoveryCodeOverlay').classList.add('hidden');
  $('recoveryCodeDisplay').textContent='';
}
async function refreshRecoveryAudit(){
  if(!state.loggedIn||!$('playerRecoveryAuditList'))return;
  try{
    const d=await api('/api/admin/player-recovery/audit');
    const labels={TEMPORARY_ISSUED:'Código temporário gerado',TEMPORARY_USED:'Código temporário utilizado',PERSONAL_USED:'Código pessoal utilizado',PERSONAL_ISSUED:'Código pessoal gerado',PERSONAL_ROTATED:'Código pessoal substituído'};
    $('playerRecoveryAuditList').innerHTML=d.audit.length?d.audit.map(x=>`<div class="manager-item recovery-audit-row"><div><strong>${safe(x.player_name||'Jogador excluído')}</strong><small>${safe(labels[x.action]||x.action)} · ${fmtDateTime(x.created_at)} · ${safe(x.admin_username||'Jogador')}</small>${x.reason?`<small>Motivo: ${safe(x.reason)}</small>`:''}</div></div>`).join(''):'<p class="muted-note">Nenhuma recuperação registrada.</p>';
  }catch(e){$('playerRecoveryAuditList').textContent=e.message}
}
function renderPlayerAccountRecovery(){
  if(!state.admin?.master?.players)return;
  renderPlayerDirectory();
}
async function refreshPlayerAccessRequests(){
  try{
    const data=await api('/api/admin/player-accounts');
    state.playerAccounts=data.accounts||[];
    renderPlayerAccountRecovery();
    await refreshRecoveryAudit();
    const items=state.playerAccounts.filter(a=>a.approval_status==='pending');
    const box=$('playerAccessRequests');
    if(!box)return;
    box.innerHTML=items.length?items.map(a=>`<div class="access-request-row">
       <div><strong>${safe(a.player_name)}</strong><small>Usuário: ${safe(a.username)} · Solicitado em ${fmtDateTime(a.created_at)}</small></div>
       <div class="access-request-actions"><button type="button" class="button-primary" data-access-approve="${a.player_id}">Aprovar</button>
       <button type="button" class="event-remove" data-access-reject="${a.player_id}">Recusar</button></div></div>`).join(''):'<p class="muted-note">Nenhuma solicitação de acesso pendente.</p>';
    box.querySelectorAll('[data-access-approve],[data-access-reject]').forEach(button=>button.addEventListener('click',async()=>{
      const action=button.dataset.accessApprove?'approve':'reject',pid=Number(button.dataset.accessApprove||button.dataset.accessReject);
      const entry=items.find(x=>x.player_id===pid);
      if(!entry||!confirm(`${action==='approve'?'Confirmar a identidade de':'Recusar o cadastro de'} ${entry.player_name}?`))return;
      try{button.disabled=true;await api(`/api/admin/player-accounts/${pid}/${action}`,{method:'POST',body:{}});toast(action==='approve'?'Jogador autorizado.':'Solicitação recusada.');await refreshPlayerAccessRequests();await loadLeagueEvents();}
      catch(err){button.disabled=false;toast(err.message,true)}
    }));
  }catch(err){if($('playerAccessRequests'))$('playerAccessRequests').textContent='Falha ao carregar solicitações: '+err.message;}
}
function bindEvents(){
 $('copyRecoveryCode').addEventListener('click',async()=>{
   try{await navigator.clipboard.writeText($('recoveryCodeDisplay').textContent);toast('Código copiado. Guarde-o em local privado.')}catch(e){toast('Selecione o código na tela e copie manualmente.',true)}
 });
 $('closeRecoveryCode').addEventListener('click',closeRecoveryCode);
 $('playerForgotForm').addEventListener('submit',async e=>{
   e.preventDefault();
   const password=$('recoveryNewPassword').value;
   if(password!==$('recoveryConfirmPassword').value)return toast('As senhas não coincidem.',true);
   const form=e.currentTarget,button=form.querySelector('button[type=submit]');button.disabled=true;
   try{
     const response=await api('/api/player/recovery/redeem',{method:'POST',body:{
       username:$('recoveryUsername').value.trim(),code:$('recoveryCodeInput').value.trim(),
       new_password:password,confirm_password:$('recoveryConfirmPassword').value}});
     form.reset();toast('Senha alterada. Faça login com sua nova senha.');
     showRecoveryCode(response.recovery_code,'Novo código pessoal de recuperação');
   }catch(err){toast(err.message,true)}finally{button.disabled=false}
 });
 $('playerRecoveryGenerateForm').addEventListener('submit',async e=>{
   e.preventDefault();const form=e.currentTarget,button=form.querySelector('button');button.disabled=true;
   try{
     const response=await api('/api/player/recovery/regenerate',{method:'POST',body:{password:$('playerRecoveryConfirmPassword').value}});
     form.reset();$('recoverySetupHint').classList.add('hidden');
     if(state.playerSession)state.playerSession.has_recovery_code=true;
     showRecoveryCode(response.recovery_code,'Novo código pessoal de recuperação');
   }catch(err){toast(err.message,true)}finally{button.disabled=false}
 });
 window.addEventListener('hashchange',()=>applyRoute(true));
 $('seasonSelect').addEventListener('change',e=>{state.season=e.target.value;matchesExpanded=false;loadPublic()});
 $('rankingSearch').addEventListener('input',renderRanking);$('matchesSearch').addEventListener('input',renderMatches);
 $('matchesExpand').addEventListener('click',()=>{matchesExpanded=!matchesExpanded;renderMatches()});
 $('closeDetail').addEventListener('click',()=>navigateTo('#/ranking'));$('detailOverlay').addEventListener('click',e=>{if(e.target===$('detailOverlay'))navigateTo('#/ranking')});
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('detailOverlay').classList.contains('hidden'))navigateTo('#/ranking')});
 $('playerLoginForm').addEventListener('submit',async e=>{
   e.preventDefault();try{
     await api('/api/player/login',{method:'POST',body:{username:$('playerLoginUsername').value.trim(),password:$('playerLoginPassword').value}});
     $('playerLoginPassword').value='';toast('Bem-vindo à sua área de jogador.');await refreshPlayerSession();
   }catch(err){toast(err.message,true)}
 });
 $('playerRegisterId').addEventListener('change',()=>{$('playerRegisterNewNameWrap').classList.toggle('hidden',Boolean($('playerRegisterId').value));});
 $('playerRegisterForm').addEventListener('submit',async e=>{
   e.preventDefault();
   const pw=$('playerRegisterPassword').value;
   if(pw!==$('playerRegisterConfirm').value)return toast('As senhas não coincidem.',true);
   try{
     const body={username:$('playerRegisterUsername').value.trim(),password:pw};
     if($('playerRegisterId').value)body.player_id=Number($('playerRegisterId').value);
     else body.player_name=$('playerRegisterName').value.trim();
     const response=await api('/api/player/register',{method:'POST',body});
     $('playerRegisterForm').reset();$('playerRegisterNewNameWrap').classList.remove('hidden');
     $('playerRegisterMessage').textContent=response.message;
     if(response.recovery_code)showRecoveryCode(response.recovery_code,'Seu código pessoal — guarde agora');
     toast('Cadastro enviado. Confirmação necessária apenas no primeiro acesso.');
     await loadPublic();
   }catch(err){$('playerRegisterMessage').textContent=err.message;toast(err.message,true)}
 });
 $('playerStatsSeason').addEventListener('change',()=>{state.playerStatsSeason=$('playerStatsSeason').value;refreshPlayerResults();});
 $('playerLogoutBtn').addEventListener('click',async()=>{try{await api('/api/player/logout',{method:'POST',body:{}});state.playerSession=null;await refreshPlayerSession();toast('Você saiu da sua conta.')}catch(err){toast(err.message,true)}});
 $('playerUsernameForm').addEventListener('submit',async e=>{
   e.preventDefault();const form=e.currentTarget,button=form.querySelector('button[type="submit"]');button.disabled=true;
   try{
     await api('/api/player/username',{method:'POST',body:{new_username:$('playerNewUsername').value.trim(),current_password:$('playerUsernamePassword').value}});
     $('playerUsernamePassword').value='';toast('Nome de usuário atualizado. Use o novo login na próxima vez.');
     await refreshPlayerSession();
   }catch(err){toast(err.message,true)}finally{button.disabled=false}
 });
 $('playerDisplayNameForm').addEventListener('submit',async e=>{
   e.preventDefault();const form=e.currentTarget,button=form.querySelector('button[type="submit"]');button.disabled=true;
   try{
     await api('/api/player/display-name',{method:'POST',body:{new_name:$('playerNewDisplayName').value.trim(),current_password:$('playerNamePassword').value}});
     $('playerNamePassword').value='';toast('Nome de jogador atualizado em seus dados da Bloodline.');
     await loadPublic();await refreshPlayerSession();
     if(state.loggedIn){await loadAdmin();}
   }catch(err){toast(err.message,true)}finally{button.disabled=false}
 });
 $('playerPasswordForm').addEventListener('submit',async e=>{e.preventDefault();try{
   await api('/api/player/password',{method:'POST',body:{current_password:$('playerOldPassword').value,new_password:$('playerNewPassword').value}});
   $('playerPasswordForm').reset();toast('Senha atualizada.');
 }catch(err){toast(err.message,true)}});
 $('loginForm').addEventListener('submit',async e=>{e.preventDefault();try{await api('/api/login',{method:'POST',body:{username:$('adminUsername').value.trim(),password:$('adminPassword').value}});$('adminPassword').value='';toast('Acesso autorizado.');await refreshAdminSession()}catch(err){toast(err.message,true)}});
 $('logoutBtn').addEventListener('click',async()=>{try{await api('/api/logout',{method:'POST',body:{}});state.admin=null;await refreshAdminSession();toast('Sessão encerrada.')}catch(err){toast(err.message,true)}});
 ['eventAgendaSearch','eventAgendaDate','eventAgendaSeason','eventAgendaPrimary'].forEach(id=>{
   $(id).addEventListener(id==='eventAgendaSearch'?'input':'change',()=>renderLeagueEvents());
 });
 $('refreshResultGroups').addEventListener('click',loadResultGroups);
 $('eventForm').addEventListener('submit',async e=>{
   e.preventDefault();
   const editing=state.editingEventId;
   try{
     const body={name:$('eventName').value.trim(),event_date:isoFromBrazilianDate($('eventDate').value),season_id:Number($('eventSeason').value),episode:$('eventEpisode').value.trim()};
     const data=await api(editing?`/api/admin/events/${editing}`:'/api/admin/events',{method:editing?'PUT':'POST',body});
     if(!editing)state.selectedEventId=data.id;
     resetEventForm();await loadLeagueEvents();toast(editing?'Evento atualizado.':'Evento criado com sucesso.');
   }catch(err){toast(err.message,true)}
 });
 $('eventCancelEdit').addEventListener('click',resetEventForm);
 $('eventPlayer').addEventListener('change',updateEventAdminDecks);
 $('eventTribe').addEventListener('change',updateEventAdminDecks);
 $('eventDeck').addEventListener('change',()=>{
   const deck=state.public?.decks?.find(d=>String(d.id)===$('eventDeck').value);
   if(deck)$('eventTribe').value=String(deck.tribe_id);
   syncSearchableSelects();
 });
 $('signupPlayer').addEventListener('change',updateSignupDecks);
 $('signupTribe').addEventListener('change',updateSignupDecks);
 $('signupDeck').addEventListener('change',()=>{
   const d=state.public?.decks?.find(d=>String(d.id)===$('signupDeck').value);
   if(d)$('signupTribe').value=String(d.tribe_id);
   updateSignupDeckHint();syncSearchableSelects();
 });
 $('signupForm').addEventListener('submit',submitSignup);
 $('copyInviteLink').addEventListener('click',async()=>{
    try{await navigator.clipboard.writeText($('inviteLink').value);toast('Link copiado.')}catch{ $('inviteLink').select();toast('Selecione e copie o link.');}
 });
 $('eventRegisterForm').addEventListener('submit',async e=>{
   e.preventDefault();
   if(!state.selectedEventId)return toast('Selecione um evento.',true);
   try{
     await api(`/api/admin/events/${state.selectedEventId}/registrations`,{method:'POST',body:{player_id:Number($('eventPlayer').value),tribe_id:Number($('eventTribe').value),deck_id:$('eventDeck').value||null}});
     $('eventPlayer').value='';$('eventTribe').value='';updateEventAdminDecks();
     await loadLeagueEvents();toast('Jogador adicionado ao evento.');
   }catch(err){toast(err.message,true)}
 });
 $('createAdminForm').addEventListener('submit',async e=>{
   e.preventDefault();
   try{
     const pw=$('newAdminPassword').value;passwordsMatch(pw,$('newAdminConfirm').value);
     await api('/api/admin/users',{method:'POST',body:{username:$('newAdminUsername').value.trim(),password:pw}});
     $('createAdminForm').reset();toast('Administrador criado com sucesso.');await loadAdminUsers();
   }catch(err){toast(err.message,true)}
 });
 $('resetAdminForm').addEventListener('submit',async e=>{
   e.preventDefault();
   try{
     const id=$('resetAdminUser').value;
     if(!id)throw new Error('Selecione um administrador.');
     const pw=$('resetAdminPassword').value;passwordsMatch(pw,$('resetAdminConfirm').value);
     if(!confirm('Redefinir senha e encerrar todas as sessões dessa conta?'))return;
     await api(`/api/admin/users/${id}`,{method:'PUT',body:{password:pw}});
     $('resetAdminForm').reset();toast('Senha redefinida e sessões encerradas.');await loadAdminUsers();
   }catch(err){toast(err.message,true)}
 });
 $('changeAdminPasswordForm').addEventListener('submit',async e=>{
   e.preventDefault();
   try{
     const pw=$('myNewPassword').value;passwordsMatch(pw,$('myConfirmPassword').value);
     await api('/api/admin/change-password',{method:'POST',body:{current_password:$('myCurrentPassword').value,new_password:pw}});
     $('changeAdminPasswordForm').reset();toast('Senha alterada com sucesso.');
   }catch(err){toast(err.message,true)}
 });
 $('exSeason').addEventListener('change',renderExclusions);
 $('mPlayer').addEventListener('change',updateAdminDeckOptions);$('mTribe').addEventListener('change',updateAdminDeckOptions);
 $('adminMatchSearch').addEventListener('input',renderAdminMatches);
 $('newPlayer').addEventListener('input',renderPlayerDirectory);
 for(const [form,endpoint,input] of [['seasonForm','seasons','newSeason'],['playerForm','players','newPlayer'],['tribeForm','tribes','newTribe']]){
   $(form).addEventListener('submit',async e=>{e.preventDefault();try{await api('/api/'+endpoint,{method:'POST',body:{name:$(input).value.trim()}});$(form).reset();toast('Cadastro criado.');await reloadAll()}catch(err){toast(err.message,true)}});
 }
 $('matchForm').addEventListener('submit',async e=>{e.preventDefault();try{const body={season_id:$('mSeason').value,event_date:isoFromBrazilianDate($('mDate').value),episode:$('mEpisode').value.trim(),round_no:$('mRound').value,player_id:$('mPlayer').value,tribe_id:$('mTribe').value,result:$('mResult').value,deck_id:$('mDeck').value};
   const path=state.editing?`/api/matches/${state.editing}`:'/api/matches';
   await api(path,{method:state.editing?'PUT':'POST',body});toast(state.editing?'Partida atualizada.':'Partida cadastrada.');resetMatchForm();await reloadAll()}catch(err){toast(err.message,true)}
 });
 $('cancelEdit').addEventListener('click',resetMatchForm);
 $('restoreDbForm').addEventListener('submit',async e=>{
   e.preventDefault();
   const file=$('restoreDbFile').files[0];
   if(!file)return;
   try{
     if(!file.name.toLowerCase().endsWith('.db'))throw new Error('Selecione o banco antigo com extensão .db.');
     if(file.size>64*1024*1024)throw new Error('O arquivo excede o limite de 64 MB.');
     if(!confirm(`Importar os resultados de "${file.name}" para o site online?\n\nAs contas administrativas serão mantidas. O sistema fará backup antes de importar.`))return;
     const button=$('restoreDbButton');
     button.disabled=true;button.textContent='Importando e criando backup...';
     $('restoreDbSummary').textContent='Enviando e conferindo o banco. Não feche esta página durante a importação.';
     try{
       const response=await fetch('/api/admin/import-db',{
         method:'POST',credentials:'same-origin',
         headers:{'X-Bloodline-Request':'1','Content-Type':'application/octet-stream'},
         body:file
       });
       let data;
       try{data=await response.json()}catch{throw new Error('Resposta inválida do servidor. Confira o ranking antes de tentar novamente.')}
       if(!response.ok)throw new Error(data.error||'Falha ao importar o banco.');
       const details=Object.entries(data.inserted||{}).filter(([k,v])=>Number(v)>0 && k!=='duplicates').map(([k,v])=>`${k}: ${v}`).join(' · ')||'Todos os registros já existiam';
       $('restoreDbSummary').textContent=`Importação concluída!\nJogadores encontrados: ${data.found.players||0} · Resultados encontrados: ${data.found.matches||0}\nNovos registros: ${details}\nAdministradores preservados: ${data.admins_preserved}. Backup: ${data.backup_created?'criado':'destino inicialmente vazio'}.`;
       toast('Dados importados. Ranking e perfis atualizados.');
       await reloadAll();
     }finally{button.disabled=false;button.textContent='Importar dados do campeonato'}
   }catch(err){$('restoreDbSummary').textContent='Não foi possível importar: '+err.message;toast(err.message,true)}
 });
 $('importForm').addEventListener('submit',async e=>{e.preventDefault();const file=$('importFile').files[0];if(!file)return;try{if(file.size>2_000_000)throw new Error('O arquivo não pode exceder 2 MB.');const bytes=await file.arrayBuffer();let csv;try{csv=new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{csv=new TextDecoder('windows-1252').decode(bytes)}const report=await api('/api/import',{method:'POST',body:{csv,season_id:$('importSeason').value}});$('importSummary').textContent=report.message+'\n'+report.errors.join('\n');toast(`${report.inserted} partidas importadas.`);await reloadAll()}catch(err){toast(err.message,true)}});
 $('downloadCsv').addEventListener('click',()=>downloadEndpoint('/api/export.csv?season='+encodeURIComponent(state.season),'bloodline_resultados.csv'));
 $('downloadJson').addEventListener('click',()=>downloadEndpoint('/api/backup.json','bloodline_backup.json'));
 $('tableForm').addEventListener('submit',submitTable);
 $('tableReset').addEventListener('click',resetTable);
 $('tCount').addEventListener('change',updateTableCount);
 $('deckFilterPlayer').addEventListener('change',renderDeckGallery);
 $('deckForm').addEventListener('submit',submitDeck);
 $('deckCancelBtn').addEventListener('click',resetDeck);
}
try{localStorage.removeItem('bloodlineDeckKeysV2')}catch{}
bindEvents();initSearchableSelects();$('eventDate').value=fmtDate(today());
applyRoute(false);
loadPublic(true).then(()=>{
  resetMatchForm();resetTable();repopulateTableSlots();
  applyRoute(false);
   if(state.currentPanel==='playerArea'||state.currentPanel==='signup')refreshPlayerSession();
});

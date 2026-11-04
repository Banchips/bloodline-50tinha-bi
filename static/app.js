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
const colors = ['#c6ef50','#9e8eff','#69d7e3','#f2b47c','#f18ba8'];
const state = {public:null, admin:null, season:'all', adminMode:false, loggedIn:false, editing:null, editingDeck:null, tables:[], canManageAdmins:false, admins:[], events:[], selectedEventId:null, editingEventId:null, openEvents:[],selectedSignupEventId:null, inviteReturnTab:'events', currentPanel:null,sessionChecked:false,sessionLoading:false};
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
    return `<div class="tribe-bar-item"><div class="tribe-bar-top"><span>${safe(t.name)} ${blocked?'<span class="zero-note">· Não pontua</span>':''}</span><span class="${blocked?'excluded':''}">${t.points} pts</span></div><div class="bar-track"><div style="width:${(t.points/max*100).toFixed(1)}%"></div></div><div class="bar-sub">${t.matches} partida(s) · ${t.players} jogador(es)</div></div>`
  }).join(''):'<div class="empty">As tribos aparecem após o primeiro resultado.</div>';
}
function renderMatches(){
  const needle=$('matchesSearch').value.trim().toLocaleLowerCase();
  const records=(state.public?.recent_matches||[]).filter(m=>(`${m.player_name} ${m.tribe_name} ${m.event_date} ${fmtDate(m.event_date)} ${m.episode} ${m.season_name}`).toLocaleLowerCase().includes(needle));
  $('matchRows').innerHTML=records.length?records.slice(0,80).map(m=>`<tr><td>${fmtDate(m.event_date)}</td><td>${safe(m.episode||'Etapa')} / R${m.round_no}${state.season==='all'?`<br><small>${safe(m.season_name)}</small>`:''}</td><td><strong>${safe(m.player_name)}</strong></td><td>${safe(m.tribe_name)}${m.excluded?' <span class="zero-note">(sem pontos)</span>':''}</td><td><span class="result-pill result-${m.result}">${resultLabels[m.result]}</span></td><td class="${m.excluded?'excluded':''}"><strong>${m.points}</strong>${m.excluded?'<small> · bloqueada</small>':''}</td></tr>`).join(''):'<tr><td class="empty" colspan="6">Nenhuma partida encontrada.</td></tr>';
}
function renderTrend(){
  const d=state.public;
  const events=d?.trend||[];
  const players=d?.ranking.slice(0,5)||[];
  if(players.length===0 || events.length===0){$('trendChart').innerHTML='<div class="empty">A evolução será exibida após o cadastro das partidas.</div>';$('trendLegend').innerHTML='';return}
  const visible=players.map(p=>({name:p.name+' · '+p.tribe_name,id:p.rank_key,values:events.map(ev=>Number(ev.points[p.rank_key]||0)),sum:p.points}));
  const width=1050,height=255,left=48,right=25,top=18,bottom=40;
  const max=Math.max(3,...visible.map(p=>p.sum));const x=i=>left+(events.length===1?(width-left-right)/2:i*(width-left-right)/(events.length-1));const y=v=>top+(height-top-bottom)*(1-v/max);
  const grid=[0,.25,.5,.75,1].map(k=>`<line x1="${left}" y1="${y(k*max)}" x2="${width-right}" y2="${y(k*max)}" stroke="#2c3850"/><text x="${left-10}" y="${y(k*max)+4}" text-anchor="end" fill="#8794aa" font-size="11">${Math.round(k*max)}</text>`).join('');
  const labels=events.map((ev,i)=>(events.length>8 && i%Math.ceil(events.length/8)!==0 && i!==events.length-1)?'':`<text x="${x(i)}" y="${height-14}" text-anchor="middle" fill="#8794aa" font-size="10">${safe(fmtDate(ev.date).slice(0,5))}</text>`).join('');
  const lines=visible.map((p,j)=>`<polyline points="${p.values.map((v,i)=>`${x(i)},${y(v)}`).join(' ')}" fill="none" stroke="${colors[j]}" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>${p.values.map((v,i)=>`<circle cx="${x(i)}" cy="${y(v)}" r="3.5" fill="${colors[j]}"/>`).join('')}`).join('');
  $('trendChart').innerHTML=`<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Evolução acumulada de pontos das cinco melhores combinações jogador e tribo">${grid}${labels}${lines}</svg>`;
  $('trendLegend').innerHTML=visible.map((p,i)=>`<span><i class="legend-dot" style="background:${colors[i]}"></i>${safe(p.name)} · ${p.sum} pts</span>`).join('');
}
// Navegação por fragmentos: cada tela tem link próprio, suporta botão direito,
// nova aba, histórico Voltar/Avançar e F5 sem depender de rotas adicionais no servidor.
const adminTabs = new Set(['review','events','roster','eligibility','import','accounts']);
function navigateTo(hash){
  if(window.location.hash===hash)applyRoute(true);
  else window.location.hash=hash;
}
function showPanel(name){
  const route={public:'#/ranking',admin:'#/admin/review',table:'#/table',decks:'#/decks',signup:'#/signup',invite:'#/invite/'+(state.selectedEventId||'')};
  navigateTo(route[name]||'#/ranking');
}
function showPanelNow(name,scroll=true){
  const previous=state.currentPanel;
  for(const [id,panel] of [['public','publicPanel'],['admin','adminPanel'],['table','tablePanel'],['decks','decksPanel'],['signup','signupPanel'],['invite','invitePanel']]) $(panel).classList.toggle('hidden',id!==name);
  state.currentPanel=name;
  state.adminMode=name==='admin';
  if(name!=='public' || !window.location.hash.startsWith('#/player/'))$('detailOverlay').classList.add('hidden');
  if(scroll)window.scrollTo(0,0);
  if((name==='admin'||name==='invite')&&!state.sessionChecked&&!state.sessionLoading)refreshAdminSession();
  if(name==='table'&&previous!=='table'){refreshPlayerForms();loadTables();}
  if(name==='decks'&&previous!=='decks'){refreshPlayerForms();renderDeckGallery();}
  if(name==='signup'&&previous!=='signup')loadOpenEvents(true);
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
    const tab=adminTabs.has(parts[1])?parts[1]:'review';
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
  if(route==='signup'){
    if(/^\d+$/.test(parts[1]||''))state.selectedSignupEventId=Number(parts[1]);
    else state.selectedSignupEventId=null;
    showPanelNow('signup',scroll);
    if(state.public)renderSignupForm();
    return;
  }
  if(route==='table'||route==='decks'){showPanelNow(route,scroll);return;}
  showPanelNow('public',scroll);
}
function showAdmin(yes){showPanel(yes?'admin':'public')}
async function refreshAdminSession(){
 if(state.sessionLoading)return;
 state.sessionLoading=true;
 try{
   const d=await api('/api/session');
   state.loggedIn=d.admin;state.canManageAdmins=Boolean(d.can_manage_admins);
   $('loginBox').classList.toggle('hidden',d.admin);
   $('adminContent').classList.toggle('hidden',!d.admin);
   $('logoutBtn').classList.toggle('hidden',!d.admin);
   $('ownerAdminSection').classList.toggle('hidden',!state.canManageAdmins);
   $('restoreDbSection').classList.toggle('hidden',!state.canManageAdmins);
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
 renderManager('seasonManager',m.seasons,'seasons');renderManager('playerManager',m.players,'players');renderManager('tribeManager',m.tribes,'tribes');
 renderExclusions();renderAdminMatches();renderTableReview();
}
function renderManager(id,items,category){
 $(id).innerHTML=items.length?items.map(item=>`<div class="manager-item"><span>${safe(item.name)} ${category==='seasons'?`<small>(ordem ${item.sort_order})</small>`:''}</span><div class="mini-buttons"><button type="button" data-rename-type="${category}" data-rename-id="${item.id}">Renomear</button><button type="button" class="danger" data-delete-category="${category}" data-delete-id="${item.id}">Excluir</button></div></div>`).join(''):'<p class="muted-note">Nenhum cadastro ainda.</p>';
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
async function reloadAll(){await loadPublic(false);await loadAdmin()}
function switchAdminTab(tab,updateUrl=true){if(updateUrl){navigateTo('#/admin/'+tab);return;}document.querySelectorAll('.admin-tab').forEach(e=>{e.classList.toggle('active',e.dataset.adminTab===tab);if(e.dataset.adminTab===tab)e.setAttribute('aria-current','page');else e.removeAttribute('aria-current')});document.querySelectorAll('.admin-pane').forEach(e=>e.classList.toggle('hidden',e.id!=='pane-'+tab))}
async function downloadEndpoint(path,filename){try{const r=await fetch(path,{credentials:'same-origin'});if(!r.ok)throw new Error('Não autorizado ou exportação indisponível.');const blob=await r.blob();const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Arquivo exportado.')}catch(err){toast(err.message,true)}}

function today(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
function getSavedDeckKeys(){try{return JSON.parse(localStorage.getItem('bloodlineDeckKeysV2')||'{}')}catch{return {}}}
function saveDeckKey(id,key){try{const keys=getSavedDeckKeys();keys[id]=key;localStorage.setItem('bloodlineDeckKeysV2',JSON.stringify(keys))}catch{toast('Armazenamento local indisponível: salve a chave exibida.',true)}}
function refreshPlayerForms(){
  if(!state.public)return;
  const d=state.public;
  const seasons=d.seasons||[];
  const v=$('tSeason').value;
  $('tSeason').innerHTML=selectOptions(seasons,v||(state.season!=='all'?state.season:seasons.at(-1)?.id),'Selecione a temporada');
  const saved=$('dPlayer').value, tribe=$('dTribe').value,filter=$('deckFilterPlayer').value;
  $('dPlayer').innerHTML=selectOptions(d.players||getRegisteredPlayers(),saved,'Escolha um jogador');
  $('dTribe').innerHTML=selectOptions(d.tribes||getRegisteredTribes(),tribe,'Escolha uma tribo');
  $('deckFilterPlayer').innerHTML='<option value="all">Todos os jogadores</option>'+getRegisteredPlayers().map(x=>`<option value="${x.id}">${safe(x.name)}</option>`).join('');
  $('deckFilterPlayer').value=filter||'all';
  updateSubmitterOptions();renderDeckGallery();updateSignupOptions();
}
function getRegisteredPlayers(){return state.admin?.master?.players||state.public?.players||[]}
function getRegisteredTribes(){return state.admin?.master?.tribes||state.public?.tribes||[]}
function createTableSlots(){
  $('tableSlots').innerHTML=Array.from({length:4},(_,i)=>`<article class="table-slot" id="tableSlot${i}" data-pos="${i}"><div class="slot-head"><span class="slot-number">${String(i+1).padStart(2,'0')}</span><strong>PLAYER ${i+1}</strong></div><label>Jogador<select class="slot-player" data-pos="${i}" required></select></label><label>Deck (opcional)<select class="slot-deck" data-pos="${i}"></select></label><label>Tribo<select class="slot-tribe" data-pos="${i}" required></select></label><label>Resultado<select class="slot-result" data-pos="${i}"><option value="D">Morreu · Derrota (0)</option><option value="V">Venceu (3)</option><option value="E">Empatou (1)</option></select></label></article>`).join('');
  document.querySelectorAll('.slot-player').forEach(el=>el.addEventListener('change',()=>{updateSlotDeck(el.dataset.pos);updateSubmitterOptions()}));
  document.querySelectorAll('.slot-deck').forEach(el=>el.addEventListener('change',()=>{const pos=el.dataset.pos;const d=state.public?.decks.find(d=>String(d.id)===el.value);if(d)document.querySelector(`.slot-tribe[data-pos="${pos}"]`).value=d.tribe_id}));
  document.querySelectorAll('.slot-tribe').forEach(el=>el.addEventListener('change',()=>{const pos=el.dataset.pos;const d=document.querySelector(`.slot-deck[data-pos="${pos}"]`);const selected=state.public?.decks.find(x=>String(x.id)===d.value);if(selected && String(selected.tribe_id)!==el.value)d.value=''}));
  document.querySelector('.slot-result[data-pos="0"]').value='V';
  updateTableCount();
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
  $('pendingCount').textContent=pending.length||'';
  $('pendingCount').classList.toggle('hidden',!pending.length);
  const sorted=[...pending,...tables.filter(t=>t.status!=='pending')].slice(0,150);
  $('tableReviewList').innerHTML=sorted.length?sorted.map(t=>`<article class="review-item"><div><strong>#${t.id} · ${safe(t.season_name)} · ${safe(t.episode)} · R${t.round_no} / Mesa ${t.table_no}</strong><div class="muted-note">${fmtDate(t.event_date)} · Enviado por ${safe(t.submitter_name||'Admin')} · <span class="review-${t.status}">${t.status==='pending'?'PENDENTE':t.status==='approved'?'APROVADA':'REJEITADA'}</span></div><div class="review-entries">${t.entries.map(e=>`<span>${safe(e.player_name)} (${safe(e.tribe_name)}) · <strong>${e.result}</strong>${e.deck_name?' · '+safe(e.deck_name):''}</span>`).join('')}</div>${t.admin_note?`<small>Observação: ${safe(t.admin_note)}</small>`:''}</div><div class="mini-buttons">${t.status==='pending'?`<button data-review="${t.id}" data-status="approved">Aprovar</button><button class="danger" data-review="${t.id}" data-status="rejected">Rejeitar</button>`:`<button class="danger" data-remove-table="${t.id}">Excluir mesa</button>`}</div></article>`).join(''):'<p class="muted-note">Nenhuma mesa enviada ainda.</p>';
  $('tableReviewList').querySelectorAll('button[data-review]').forEach(b=>b.addEventListener('click',async()=>{
    const approved=b.dataset.status==='approved';if(!confirm(approved?'Aprovar a mesa e somar os pontos?':'Rejeitar esta mesa?'))return;
    const note=approved?'':(prompt('Motivo da rejeição (opcional):','')||'');
    try{await api('/api/tables/'+b.dataset.review,{method:'PUT',body:{status:b.dataset.status,note}});toast(approved?'Mesa aprovada.':'Mesa rejeitada.');await reloadAll();await loadTables()}catch(err){toast(err.message,true)}
  }));
  $('tableReviewList').querySelectorAll('button[data-remove-table]').forEach(b=>b.addEventListener('click',async()=>{
    if(!confirm('Excluir esta mesa e os resultados vinculados? Essa ação não pode ser desfeita.'))return;
    try{await api('/api/tables/'+b.dataset.removeTable,{method:'DELETE',body:{}});toast('Mesa excluída.');await reloadAll();await loadTables()}catch(err){toast(err.message,true)}
  }));
}
function updateAdminDeckOptions(){
  const player=$('mPlayer').value,tribe=$('mTribe').value,old=$('mDeck').value;
  const list=(state.admin?.decks||[]).filter(d=>String(d.player_id)===player && String(d.tribe_id)===tribe);
  $('mDeck').innerHTML=selectOptions(list,old,'Sem deck vinculado');
}
function renderDeckGallery(){
  const player=$('deckFilterPlayer').value||'all';
  const arr=(state.public?.decks||[]).filter(d=>player==='all'||String(d.player_id)===player);
  const keys=getSavedDeckKeys();
  $('deckGallery').innerHTML=arr.length?arr.map(d=>{
    const pn=getRegisteredPlayers().find(p=>p.id===d.player_id)?.name||'';
    return `<article class="deck-card"><div><span class="kicker">${safe(pn)} · ${safe(d.tribe_name)}</span><h3>${safe(d.name)}</h3></div><div class="deck-card-actions"><a href="${safe(d.url)}" class="deck-link" target="_blank" rel="noopener noreferrer">Abrir decklist ↗</a><button data-edit-deck="${d.id}" class="button-outline">${keys[d.id]||state.loggedIn?'Editar deck':'Editar com chave'}</button>${state.loggedIn?`<button data-delete-deck="${d.id}" class="button-outline danger">Excluir</button>`:''}</div></article>`}).join(''):'<p class="muted-note">Nenhum deck enviado para este jogador.</p>';
  $('deckGallery').querySelectorAll('button[data-edit-deck]').forEach(b=>b.addEventListener('click',()=>editDeck(Number(b.dataset.editDeck))));
  $('deckGallery').querySelectorAll('button[data-delete-deck]').forEach(b=>b.addEventListener('click',async()=>{
    if(!confirm('Excluir esta decklist? Os resultados já existentes continuarão no histórico, sem o vínculo ao deck.'))return;
    try{await api('/api/decks/'+b.dataset.deleteDeck,{method:'DELETE',body:{}});toast('Deck removido.');await reloadAll()}catch(err){toast(err.message,true)}
  }));
}
function editDeck(id){
  const d=state.public?.decks.find(x=>x.id===id);if(!d)return;
  state.editingDeck=id;
  $('dPlayer').value=d.player_id;$('dTribe').value=d.tribe_id;$('dName').value=d.name;$('dUrl').value=d.url;
  $('dPlayer').disabled=true;$('dTribe').disabled=true;
  $('dEditKey').value=getSavedDeckKeys()[id]||'';
  $('deckKeyBox').classList.toggle('hidden',state.loggedIn);
  $('deckFormTitle').textContent='Editar decklist · '+d.name;
  $('deckSaveBtn').textContent='Salvar mudanças';$('deckCancelBtn').classList.remove('hidden');$('deckCreated').classList.add('hidden');
  $('deckForm').scrollIntoView({behavior:'smooth',block:'start'});
}
function resetDeck(){
  state.editingDeck=null;$('deckForm').reset();$('dPlayer').disabled=false;$('dTribe').disabled=false;
  $('deckFormTitle').textContent='Cadastrar meu deck';$('deckSaveBtn').textContent='Enviar decklist';$('deckCancelBtn').classList.add('hidden');$('deckKeyBox').classList.add('hidden');
}
async function submitDeck(e){
  e.preventDefault();
  const body={player_id:$('dPlayer').value,tribe_id:$('dTribe').value,name:$('dName').value.trim(),url:$('dUrl').value.trim()};
  const editing=state.editingDeck;
  if(editing && !state.loggedIn)body.edit_key=$('dEditKey').value.trim();
  try{
    const result=await api(editing?`/api/decks/${editing}`:'/api/decks',{method:editing?'PUT':'POST',body});
    if(!editing){
      saveDeckKey(result.id,result.edit_key);
      $('deckCreated').classList.remove('hidden');
      $('deckCreated').innerHTML=`<strong>Deck #${result.id} cadastrado com sucesso!</strong><p>Guarde esta chave para editar de outro navegador. Ela não será exibida novamente pelo servidor.</p><div class="key-row"><input readonly id="newDeckKey" value="${safe(result.edit_key)}"><button type="button" class="button-outline" id="copyDeckKey">Copiar</button></div>`;
      $('copyDeckKey').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(result.edit_key);toast('Chave copiada.')}catch{ $('newDeckKey').select();toast('Selecione e copie a chave apresentada.')}});
    }else{if(body.edit_key)saveDeckKey(editing,body.edit_key);$('deckCreated').classList.add('hidden')}
    resetDeck();toast(editing?'Decklist atualizada.':'Decklist cadastrada.');await loadPublic();if(state.loggedIn)await loadAdmin();
  }catch(err){toast(err.message,true)}
}
// Gestão administrativa de eventos, independente das partidas e do ranking.
async function loadLeagueEvents(){
  if(!state.loggedIn)return;
  try{
    const data=await api('/api/admin/events');
    state.events=data.events||[];
    const match=window.location.hash.match(/^#\/admin\/events\/(\d+)$/);
    if(match)state.selectedEventId=Number(match[1]);
    if(!state.events.some(e=>e.id===state.selectedEventId))state.selectedEventId=state.events[0]?.id||null;
    renderLeagueEvents();
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
  $('eventList').innerHTML=events.length?events.map(ev=>`<article class="event-list-item ${ev.id===state.selectedEventId?'selected':''}">
   <a class="event-list-select" href="#/admin/events/${ev.id}" data-event-open="${ev.id}" ${ev.id===state.selectedEventId?'aria-current="page"':''}>
    <span class="event-day">${safe(fmtDate(ev.event_date))}</span><strong>${safe(ev.name)}</strong>
    <small>${safe(ev.season_name)} · ${safe(ev.episode)} · ${ev.total_registered} inscrito(s) · ${ev.registrations_open?'INSCRIÇÕES ABERTAS':'INSCRIÇÕES FECHADAS'}</small>
   </a><a class="event-qr-btn" href="#/invite/${ev.id}" data-event-invite="${ev.id}" title="Abrir QR Code e link de inscrição" aria-label="QR Code e link para ${safe(ev.name)}">▦ QR</a><button class="event-edit-btn" type="button" data-event-edit="${ev.id}" aria-label="Editar evento ${safe(ev.name)}">Editar</button><button class="event-delete-btn" type="button" data-event-delete="${ev.id}" aria-label="Excluir evento ${safe(ev.name)}">Excluir</button>
  </article>`).join(''):'<p class="muted-note">Nenhum evento cadastrado. Crie o primeiro no formulário ao lado.</p>';

  $('eventList').querySelectorAll('[data-event-edit]').forEach(btn=>btn.addEventListener('click',()=>{
    const ev=events.find(e=>e.id===Number(btn.dataset.eventEdit));if(!ev)return;
    state.selectedEventId=ev.id;state.editingEventId=ev.id;
    $('eventDate').value=fmtDate(ev.event_date);$('eventName').value=ev.name;
    $('eventSeason').value=String(ev.season_id);$('eventEpisode').value=ev.episode;
    $('eventFormTitle').textContent='Editar evento';$('eventSave').textContent='Salvar evento';
    $('eventCancelEdit').classList.remove('hidden');renderLeagueEvents();
    $('eventForm').scrollIntoView({behavior:'smooth',block:'start'});
  }));
  $('eventList').querySelectorAll('[data-event-delete]').forEach(btn=>btn.addEventListener('click',async()=>{
    const ev=events.find(e=>e.id===Number(btn.dataset.eventDelete));if(!ev)return;
    if(!confirm(`Excluir o evento "${ev.name}" (${ev.season_name} · ${ev.episode}) e suas ${ev.total_registered} inscrição(ões)?\n\nEsta ação é permanente. Resultados já lançados são protegidos.`))return;
    try{
      await api(`/api/admin/events/${ev.id}`,{method:'DELETE',body:{}});
      if(state.editingEventId===ev.id)resetEventForm();
      if(state.selectedEventId===ev.id)state.selectedEventId=null;
      if(window.location.hash===`#/admin/events/${ev.id}`)navigateTo('#/admin/events');
      await loadLeagueEvents();toast('Evento e inscrições excluídos.');
    }catch(err){toast(err.message,true)}
  }));
  renderEventRoster();
}
function renderEventRoster(){
  const ev=state.events.find(x=>x.id===state.selectedEventId);
  $('eventRosterTitle').textContent=ev?ev.name:'Lista de jogadores';
  $('eventRosterSubtitle').textContent=ev?`${fmtDate(ev.event_date)} · ${ev.season_name} · ${ev.episode}`:'Cadastre e selecione um evento para inscrever jogadores.';
  $('eventRosterContent').classList.toggle('hidden',!ev);
  $('eventRosterStats').innerHTML=ev?`<a class="event-roster-qr" id="eventRosterQR" href="#/invite/${ev.id}" title="Abrir convite e QR Code">▦ QR / Link</a><span>${ev.total_registered} inscritos</span><span>${ev.total_checkin} check-ins</span><span>${ev.total_paid} pagos</span><span>${ev.total_decklists_ok} decklists OK</span><button type="button" id="toggleEventOpen" class="event-open-switch ${ev.registrations_open?'on':''}" aria-pressed="${Boolean(ev.registrations_open)}">${ev.registrations_open?'● Inscrições abertas':'○ Abrir inscrições'}</button>`:'';
  if(ev){
    $('toggleEventOpen').addEventListener('click',async e=>{
      const next=!Boolean(ev.registrations_open);
      if(!confirm(`${next?'Abrir':'Fechar'} as inscrições públicas para ${ev.name}?`))return;
      e.currentTarget.disabled=true;
      try{
        await api(`/api/admin/events/${ev.id}`,{method:'PUT',body:{registrations_open:next}});
        await loadLeagueEvents();await loadOpenEvents();toast(next?'Inscrições abertas.':'Inscrições encerradas.');
      }catch(err){toast(err.message,true);await loadLeagueEvents()}
    });
  }
  if(!ev)return;
  const tribes=state.admin?.master?.tribes||[];
  $('eventRosterRows').innerHTML=ev.registrations.length?ev.registrations.map(r=>`<tr>
    <td><strong>${safe(r.player_name)}</strong>${r.deck_url?`<small class="event-deck-small"><a href="${safe(r.deck_url)}" target="_blank" rel="noopener noreferrer">▤ ${safe(r.deck_name)} ↗</a></small>`:''}</td>
    <td><select class="event-tribe-select" data-event-tribe="${r.id}" aria-label="Tribo de ${safe(r.player_name)}">${tribes.map(t=>`<option value="${t.id}" ${t.id===r.tribe_id?'selected':''}>${safe(t.name)}</option>`).join('')}</select></td>
    <td><button type="button" class="event-toggle ${r.checkin?'on':''}" data-event-toggle="${r.id}" data-field="checkin" aria-pressed="${Boolean(r.checkin)}" title="${r.checkin?'Check-in confirmado':'Check-in pendente'}"><span aria-hidden="true">${r.checkin?'✓':'○'}</span><small>${r.checkin?'Feito':'Pendente'}</small></button></td>
    <td><button type="button" class="event-toggle ${r.paid?'on':''}" data-event-toggle="${r.id}" data-field="paid" aria-pressed="${Boolean(r.paid)}" title="${r.paid?'Pagamento confirmado':'Pagamento pendente'}"><span aria-hidden="true">${r.paid?'✓':'○'}</span><small>${r.paid?'Pago':'Pendente'}</small></button></td>
    <td><button type="button" class="event-toggle ${r.decklist_ok?'on':''}" data-event-toggle="${r.id}" data-field="decklist_ok" aria-pressed="${Boolean(r.decklist_ok)}" title="${r.decklist_ok?'Decklist aprovada':'Decklist ainda não aprovada'}"><span aria-hidden="true">${r.decklist_ok?'✓':'✕'}</span><small>${r.decklist_ok?'OK':'Não'}</small></button></td>
    <td><button type="button" class="event-remove" data-event-remove="${r.id}" aria-label="Remover ${safe(r.player_name)} deste evento">Remover</button></td>
  </tr>`).join(''):'<tr><td class="empty" colspan="6">Nenhum jogador inscrito neste evento.</td></tr>';
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
  $('eventRosterRows').querySelectorAll('[data-event-remove]').forEach(btn=>btn.addEventListener('click',async()=>{
    const registration=ev.registrations.find(x=>x.id===Number(btn.dataset.eventRemove));
    if(!registration||!confirm(`Remover ${registration.player_name} deste evento? Isso não apaga o cadastro geral nem resultados.`))return;
    try{await api(`/api/admin/events/${ev.id}/registrations/${registration.id}`,{method:'DELETE',body:{}});await loadLeagueEvents();toast('Inscrição removida.');}
    catch(err){toast(err.message,true)}
  }));
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
  $('signupForm').classList.toggle('hidden',!enabled);
  $('signupEventTitle').textContent=current?current.name:'Inscrições encerradas';
  $('signupEventInfo').textContent=current?`${current.season_name} · ${current.episode} · ${fmtDate(current.event_date)}`:'Este evento não está com inscrições abertas. Consulte a organização ou selecione outro EP disponível.';
  if(current){$('signupEventName').value=current.name;updateSignupOptions();}
}
function updateSignupOptions(){
  const m=state.public;
  if(!m)return;
  const player=$('signupPlayer').value,tribe=$('signupTribe').value;
  $('signupPlayer').innerHTML=selectOptions(m.players||[],player,'Selecione seu jogador');
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
    await api('/api/events/register',{method:'POST',body:{event_id:ev.id,player_id:Number($('signupPlayer').value),tribe_id:Number($('signupTribe').value),deck_id:$('signupDeck').value||null}});
    $('signupMessage').textContent=`✓ Inscrição recebida para ${ev.name}! Procure a organização para confirmar check-in, pagamento e aprovação da decklist.`;
    toast('Inscrição enviada com sucesso!');
    $('signupPlayer').value='';$('signupTribe').value='';updateSignupDecks();await loadOpenEvents();
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
function bindEvents(){
 window.addEventListener('hashchange',()=>applyRoute(true));
 $('seasonSelect').addEventListener('change',e=>{state.season=e.target.value;loadPublic()});
 $('rankingSearch').addEventListener('input',renderRanking);$('matchesSearch').addEventListener('input',renderMatches);
 $('closeDetail').addEventListener('click',()=>navigateTo('#/ranking'));$('detailOverlay').addEventListener('click',e=>{if(e.target===$('detailOverlay'))navigateTo('#/ranking')});
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('detailOverlay').classList.contains('hidden'))navigateTo('#/ranking')});
 $('loginForm').addEventListener('submit',async e=>{e.preventDefault();try{await api('/api/login',{method:'POST',body:{username:$('adminUsername').value.trim(),password:$('adminPassword').value}});$('adminPassword').value='';toast('Acesso autorizado.');await refreshAdminSession()}catch(err){toast(err.message,true)}});
 $('logoutBtn').addEventListener('click',async()=>{try{await api('/api/logout',{method:'POST',body:{}});state.admin=null;await refreshAdminSession();toast('Sessão encerrada.')}catch(err){toast(err.message,true)}});
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
 });
 $('signupPlayer').addEventListener('change',updateSignupDecks);
 $('signupTribe').addEventListener('change',updateSignupDecks);
 $('signupDeck').addEventListener('change',()=>{
   const d=state.public?.decks?.find(d=>String(d.id)===$('signupDeck').value);
   if(d)$('signupTribe').value=String(d.tribe_id);
   updateSignupDeckHint();
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
bindEvents();$('eventDate').value=fmtDate(today());
applyRoute(false);
loadPublic(true).then(()=>{
  resetMatchForm();resetTable();repopulateTableSlots();
  applyRoute(false);
});

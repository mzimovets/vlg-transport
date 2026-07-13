'use strict';
/* ============ Волгоградский транспорт — офлайн-табло ============ */

const D = window.TRANSIT_DATA;
const pad = n => String(n).padStart(2,'0');
const fmt = m => `${pad(Math.floor(m/60)%24)}:${pad(Math.round(m)%60)}`;
const RU_DAYS = ['воскресенье','понедельник','вторник','среда','четверг','пятница','суббота'];


/* ---------- favorites (localStorage) ----------
   Each favorite: {key:"tram:4", dir:"fwd", stopIdx:0} */
function loadFavorites(){
  try { return JSON.parse(localStorage.getItem('vlg_favorites')||'[]'); }
  catch(e){ return []; }
}
function saveFavorites(list){ localStorage.setItem('vlg_favorites', JSON.stringify(list)); }
function isFavorite(kind, id){ return loadFavorites().some(f=>f.key===`${kind}:${id}`); }
function toggleFavorite(kind, id, dir, stopIdx){
  const list = loadFavorites();
  const k = `${kind}:${id}`;
  const idx = list.findIndex(f=>f.key===k);
  if (idx>=0) list.splice(idx,1);
  else list.push({key:k, dir: dir||'fwd', stopIdx: stopIdx||0});
  saveFavorites(list);
}
function updateFavoriteView(kind, id, dir, stopIdx){
  const list = loadFavorites();
  const f = list.find(x=>x.key===`${kind}:${id}`);
  if (f){ f.dir = dir; f.stopIdx = stopIdx; saveFavorites(list); }
}

/* ---------- service-day detection ---------- */
function serviceNow(){
  const d = new Date();
  let t = d.getHours()*60 + d.getMinutes() + d.getSeconds()/60;
  const ref = new Date(d);
  if (d.getHours() < 3){ t += 1440; ref.setDate(ref.getDate()-1); }
  const dow = ref.getDay();
  return { t, auto: (dow===0||dow===6) ? 'we' : 'wd', now:d };
}

/* ============ Route model abstraction ============
   Trams: pre-parsed per-trip minute arrays + anchor columns -> interpolate.
   Buses: terminus departure-time lists + proportional stop interpolation
          across the known end-to-end trip duration. */

function getRoute(kind, id){
  return kind==='tram' ? D.trams[id] : D.buses[id];
}
function stopsFor(kind, id, dir){
  const r = getRoute(kind, id);
  return dir==='fwd' ? r.stops_fwd : r.stops_fwd.slice().reverse();
}

function tramTimeAtStop(route, dir, trip, sIdx){
  const anchors = route.anchors[dir];
  const cols = Object.keys(anchors).map(Number).sort((a,b)=>a-b);
  if (anchors[sIdx] !== undefined){
    const v = trip.t[anchors[sIdx]];
    return v==null ? null : {m:v, approx:false};
  }
  let lo=null, hi=null;
  for (const s of cols){ if (s<sIdx) lo=s; if (s>sIdx && hi===null) hi=s; }
  if (lo===null || hi===null) return null;
  const a = trip.t[anchors[lo]], b = trip.t[anchors[hi]];
  if (a==null || b==null) return null;
  return {m: Math.round(a + (b-a)*(sIdx-lo)/(hi-lo)), approx:true};
}

function parseTimeList(str){
  return str.trim().split(/\s+/).map(s=>{
    const [h,m] = s.split(':').map(Number);
    return h<3 ? h*60+m+1440 : h*60+m; // unify into 3:00-27:00 service window
  });
}

function busTripsFor(route, day, dir){
  const list = route.days[day] && route.days[day][dir];
  if (!list) return [];
  return parseTimeList(list).map(dep => ({dep}));
}

function busTimeAtStop(route, dir, trip, sIdx, totalStops){
  // proportional interpolation across the full known trip duration
  const frac = totalStops<=1 ? 0 : sIdx/(totalStops-1);
  return { m: Math.round(trip.dep + route.duration_min*frac), approx: sIdx>0 && sIdx<totalStops-1 };
}

/* Build the "upcoming arrivals" list for a given kind/id/dir/stopIdx */
function computeUpcoming(kind, id, dir, stopIdx, dayMode){
  const { t, auto } = serviceNow();
  const day = dayMode==='auto' ? auto : dayMode;
  const route = getRoute(kind, id);
  const stops = stopsFor(kind, id, dir);
  const isTerminus = stopIdx === stops.length-1;
  const upcoming = [];
  if (isTerminus) return { upcoming, isTerminus, day, auto, t, stops };

  if (kind==='tram'){
    const trips = route.days[day][dir];
    for (const trip of trips){
      const at = tramTimeAtStop(route, dir, trip, stopIdx);
      if (!at) continue;
      const delta = at.m - t;
      if (delta < -0.75) continue;
      upcoming.push({...at, delta, meta: {depot:!!trip.depot, r3:!!trip.r3}});
    }
  } else {
    const trips = busTripsFor(route, day, dir);
    for (const trip of trips){
      const at = busTimeAtStop(route, dir, trip, stopIdx, stops.length);
      const delta = at.m - t;
      if (delta < -0.75) continue;
      upcoming.push({...at, delta, meta:{}});
    }
  }
  upcoming.sort((a,b)=>a.m-b.m);
  return { upcoming, isTerminus, day, auto, t, stops };
}

function nextArrivalLabel(kind, id, dir, stopIdx){
  const { upcoming, isTerminus } = computeUpcoming(kind, id, dir, stopIdx, 'auto');
  if (isTerminus) return 'конечная';
  if (!upcoming.length) return 'нет рейсов сегодня';
  const mins = Math.max(0, Math.round(upcoming[0].delta));
  return mins===0 ? `прибывает · ${fmt(upcoming[0].m)}` : `через ${mins} мин · ${fmt(upcoming[0].m)}`;
}

function nextArrivalShort(kind, id){
  const { upcoming, isTerminus } = computeUpcoming(kind, id, 'fwd', 0, 'auto');
  if (isTerminus || !upcoming.length) return '—';
  const mins = Math.max(0, Math.round(upcoming[0].delta));
  return mins===0 ? 'сейчас' : `${mins} мин`;
}

/* ============ Rendering ============ */

const app = document.getElementById('app');
let state = { screen:'home', kind:null, id:null, dir:'fwd', stopIdx:0, dayMode:'auto' };
let refreshTimer = null;

function render(){
  clearInterval(refreshTimer);
  if (state.screen==='home') renderHome();
  else if (state.screen==='list') renderList();
  else if (state.screen==='detail') renderDetail();
}

function routeBadge(kind, id, name){
  const cls = kind==='tram' ? 'badge tram' : 'badge bus';
  return `<div class="${cls}">${id}</div>`;
}

function favoriteWidgetsHTML(filterKind){
  const favs = loadFavorites().filter(f=>{
    if (!filterKind) return true;
    return f.key.startsWith(filterKind+':');
  });
  if (!favs.length) return '';
  const cards = favs.map(f=>{
    const [kind,id] = f.key.split(':');
    const route = getRoute(kind,id);
    if (!route) return '';
    const label = nextArrivalLabel(kind, id, f.dir, f.stopIdx);
    const stops = stopsFor(kind,id,f.dir);
    const stopName = stops[f.stopIdx] || stops[0];
    return `<button class="fav-card" data-kind="${kind}" data-id="${id}" data-dir="${f.dir}" data-stop="${f.stopIdx}">
      ${routeBadge(kind,id)}
      <div class="fav-body">
        <div class="fav-name">${route.name}</div>
        <div class="fav-stop">${stopName}</div>
      </div>
      <div class="fav-eta">${label}</div>
    </button>`;
  }).join('');
  return `<div class="fav-section"><label class="fld">Избранное</label><div class="fav-list">${cards}</div></div>`;
}

function renderHome(){
  app.innerHTML = `
    <div class="topbar home">
      <div class="brand">Волгоград<span>Транспорт</span></div>
    </div>
    <div class="wrap">
      ${favoriteWidgetsHTML(null)}
      <label class="fld">Вид транспорта</label>
      <div class="route-list">
        <button class="route-row type-card tram" data-kind="tram">
          <img class="illust" src="tram-illustration.png" alt="">
          <div class="fade"></div>
          <div class="route-info">
            <div class="route-name">Трамваи</div>
            <div class="route-note">4 маршрута · 3, 4, СТ, СТ2</div>
          </div>
        </button>
        <button class="route-row type-card bus" data-kind="bus">
          <img class="illust" src="bus-illustration.png" alt="">
          <div class="fade"></div>
          <div class="route-info">
            <div class="route-name">Автобусы</div>
            <div class="route-note">5 маршрутов · 2, 25, 77, 85, 52э</div>
          </div>
        </button>
      </div>
      <div class="foot">
        <p>Расписания трамваев — по данным volgtrans.ru. Расписания автобусов проверены по двум независимым источникам (агрегаторы официальных данных МУП «ВПАТП №7» и ООО «Волгоградский автобусный парк»).</p>
      </div>
    </div>`;
  app.querySelectorAll('.route-row[data-kind]').forEach(el=>{
    el.onclick = () => { state = {...state, screen:'list', kind: el.dataset.kind}; render(); };
  });
  app.querySelectorAll('.fav-card').forEach(el=>{
    el.onclick = () => {
      state = {...state, screen:'detail', kind:el.dataset.kind, id:el.dataset.id, dir:el.dataset.dir, stopIdx:+el.dataset.stop};
      render();
    };
  });
}


function renderList(){
  const kind = state.kind;
  const ids = Object.keys(kind==='tram'?D.trams:D.buses);
  const typeName = kind==='tram' ? 'Трамваи' : 'Автобусы';
  const typeCls = kind==='tram' ? 'tram' : 'bus';
  const rows = ids.map(id=>{
    const r = getRoute(kind,id);
    const fav = isFavorite(kind,id);
    return `<button class="route-row ${typeCls}" data-id="${id}">
      ${routeBadge(kind,id)}
      <div class="route-info">
        <div class="route-name">${r.name}</div>
        ${r.note ? `<div class="route-note">${r.note}</div>` : ''}
      </div>
      <span class="route-eta">${nextArrivalShort(kind,id)}</span>
      <span class="star ${fav?'on':''}" data-star="${id}">${fav?'★':'☆'}</span>
    </button>`;
  }).join('');
  app.innerHTML = `
    <div class="topbar">
      <button class="back" id="back-btn">←</button>
      <div class="topbar-title">${typeName}</div>
    </div>
    <div class="wrap">
      ${favoriteWidgetsHTML(kind)}
      <label class="fld">Маршруты</label>
      <div class="route-list">${rows}</div>
    </div>`;
  document.getElementById('back-btn').onclick = () => { state.screen='home'; render(); };
  app.querySelectorAll('.route-row').forEach(el=>{
    el.onclick = (e) => {
      if (e.target.dataset.star) return;
      state = {...state, screen:'detail', id: el.dataset.id, dir:'fwd', stopIdx:0};
      render();
    };
  });
  app.querySelectorAll('[data-star]').forEach(el=>{
    el.onclick = (e) => {
      e.stopPropagation();
      toggleFavorite(kind, el.dataset.star, 'fwd', 0);
      renderList();
    };
  });
  app.querySelectorAll('.fav-card').forEach(el=>{
    el.onclick = () => {
      state = {...state, screen:'detail', kind:el.dataset.kind, id:el.dataset.id, dir:el.dataset.dir, stopIdx:+el.dataset.stop};
      render();
    };
  });
}

function renderDetail(){
  const { kind, id } = state;
  const route = getRoute(kind, id);
  const stops = stopsFor(kind, id, state.dir);
  if (state.stopIdx >= stops.length) state.stopIdx = 0;
  const fav = isFavorite(kind, id);
  const { t, auto } = serviceNow();
  const day = state.dayMode==='auto' ? auto : state.dayMode;
  const { upcoming, isTerminus } = computeUpcoming(kind, id, state.dir, state.stopIdx, state.dayMode);

  const typeCls = kind==='tram' ? 'tram' : 'bus';
  const revLabel = stopsFor(kind,id,'rev')[stopsFor(kind,id,'rev').length-1];
  const fwdLabel = stopsFor(kind,id,'fwd')[stopsFor(kind,id,'fwd').length-1];

  let boardHTML, tagsHTML='', nextListHTML;
  if (isTerminus){
    boardHTML = `<div class="board empty"><div class="cap">Конечная</div><div class="big">Это конечная выбранного направления — переключите направление.</div></div>`;
    nextListHTML = `<div class="row"><span class="in">—</span></div>`;
  } else if (!upcoming.length){
    boardHTML = `<div class="board empty"><div class="cap">Ближайший рейс</div><div class="big">Сегодня рейсов больше нет по этой остановке.</div></div>`;
    nextListHTML = `<div class="row"><span class="in">—</span></div>`;
  } else {
    const n = upcoming[0];
    const mins = Math.max(0, Math.round(n.delta));
    if (n.approx) tagsHTML += '<span class="tag">≈ расчётное время</span>';
    if (n.meta.depot) tagsHTML += '<span class="tag warn">в депо / короткий рейс</span>';
    if (n.meta.r3) tagsHTML += '<span class="tag">совмещён с марш. 3</span>';
    boardHTML = `<div class="board">
      <div class="cap">Ближайший · <b>${stops[state.stopIdx]}</b></div>
      <div class="big">${mins===0 ? `прибывает <span class="at">${n.approx?'≈':''}${fmt(n.m)}</span>` : `через ${mins} <span class="unit">мин</span> <span class="at">${n.approx?'≈':''}${fmt(n.m)}</span>`}</div>
      <div class="tags">${tagsHTML}</div>
    </div>`;
    nextListHTML = upcoming.slice(1,6).map(u=>{
      const mins2 = Math.round(u.delta);
      let b = '';
      if (u.approx) b += '<span class="b">≈</span>';
      if (u.meta.depot) b += '<span class="b dep">в депо</span>';
      if (u.meta.r3) b += '<span class="b r3">марш. 3</span>';
      return `<div class="row"><span class="t">${fmt(u.m)}</span><span class="in">через ${mins2} мин</span>${b}</div>`;
    }).join('') || '<div class="row"><span class="in">—</span></div>';
  }

  const anchorSet = kind==='tram' ? Object.keys(route.anchors[state.dir]).map(Number) : [0, stops.length-1];
  const stripTicks = anchorSet.map(a=>`<div class="tick" style="left:${a/(stops.length-1)*100}%"></div>`).join('');
  const stripEnds = `<div class="end end-l">${stops[0]}</div><div class="end end-r">${stops[stops.length-1]}</div>`;

  app.innerHTML = `
    <div class="topbar ${typeCls}">
      <button class="back" id="back-btn">←</button>
      <div class="topbar-title">
        ${routeBadge(kind,id)}
        <span>${route.name}</span>
      </div>
      <span class="star big-star ${fav?'on':''}" id="fav-toggle">${fav?'★':'☆'}</span>
    </div>
    <div class="wrap">
      <div class="nowline">
        <div class="nowdate"><b>${RU_DAYS[new Date().getDay()]}</b>, ${new Date().getDate()}.${pad(new Date().getMonth()+1)}</div>
        <div class="nowclock" id="nowclock">--:--</div>
      </div>
      <div class="chips">
        <button class="chip ${state.dayMode==='auto'?'on':''}" data-day="auto">Авто<small>сегодня: ${auto==='wd'?'будни':'выходной'}</small></button>
        <button class="chip ${state.dayMode==='wd'?'on':''}" data-day="wd">Будни</button>
        <button class="chip ${state.dayMode==='we'?'on':''}" data-day="we">Выходные</button>
      </div>
      <div class="seg">
        <button class="${state.dir==='fwd'?'on':''}" data-dir="fwd"><span class="arr">в сторону</span>${fwdLabel}</button>
        <button class="${state.dir==='rev'?'on':''}" data-dir="rev"><span class="arr">в сторону</span>${revLabel}</button>
      </div>
      <label class="fld">Остановка</label>
      <select id="stop-select">
        ${stops.map((s,i)=>`<option value="${i}" ${i===state.stopIdx?'selected':''}>${s}${i===stops.length-1?' (конечная)':''}</option>`).join('')}
      </select>
      <div class="strip"><div class="rail"></div>${stripTicks}<div class="me" style="left:${state.stopIdx/(stops.length-1)*100}%"></div>${stripEnds}</div>
      ${boardHTML}
      <label class="fld">Следующие рейсы</label>
      <div class="next">${nextListHTML}</div>
      <div class="foot"><p>${kind==='bus' ? 'Время на промежуточных остановках — расчётное, пропорционально общей длительности рейса.' : (route.note||'')}</p></div>
    </div>`;

  document.getElementById('back-btn').onclick = () => { state.screen='list'; render(); };
  document.getElementById('fav-toggle').onclick = () => {
    toggleFavorite(kind, id, state.dir, state.stopIdx);
    renderDetail();
  };
  app.querySelectorAll('[data-day]').forEach(el=>{
    el.onclick = () => { state.dayMode = el.dataset.day; renderDetail(); };
  });
  app.querySelectorAll('[data-dir]').forEach(el=>{
    el.onclick = () => {
      if (state.dir===el.dataset.dir) return;
      const stopName = stops[state.stopIdx];
      state.dir = el.dataset.dir;
      const newStops = stopsFor(kind,id,state.dir);
      const idx = newStops.indexOf(stopName);
      state.stopIdx = idx>=0 ? idx : 0;
      if (fav) updateFavoriteView(kind, id, state.dir, state.stopIdx);
      renderDetail();
    };
  });
  document.getElementById('stop-select').onchange = (e) => {
    state.stopIdx = +e.target.value;
    if (isFavorite(kind,id)) updateFavoriteView(kind, id, state.dir, state.stopIdx);
    renderDetail();
  };

  function tickClock(){
    const d = new Date();
    document.getElementById('nowclock').textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  tickClock();
  refreshTimer = setInterval(()=>{ tickClock(); }, 1000);
  setInterval(()=>{ if (state.screen==='detail') renderDetail(); }, 15000);
}

render();

/* ---------- PWA: register service worker (only when actually served, not file:// or a bundled single-file preview) ---------- */
if ('serviceWorker' in navigator && (location.protocol === 'http:' || location.protocol === 'https:')){
  window.addEventListener('load', () => {
    fetch('sw.js', {method:'HEAD'}).then(r=>{
      if (r.ok) navigator.serviceWorker.register('sw.js').catch(()=>{});
    }).catch(()=>{ /* no sw.js next to this file — nothing to register, stay quiet */ });
  });
}

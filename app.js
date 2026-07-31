'use strict';
const DB = window.DB || { sources: {}, movies: [] };
const M = DB.movies;
const SRC = DB.sources;

const $ = id => document.getElementById(id);
const grid = $('grid');

// escape p/ texto livre (sinopse) interpolado em HTML
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

// Todas as listas existentes na base (escala sozinho quando entrar BBC/séc. XX)
const ALL_LISTS = Object.keys(SRC);

// ---- State ----
const state = {
  q: '',
  // UNIÃO: um chip por instituto, todos ligados por padrão. Filme passa se está em ao menos uma marcada.
  lists: new Set(ALL_LISTS),
  platform: '',
  country: '',
  director: '',
  genre: '',
  maxDur: 321,
  yearMin: 0,
  yearMax: 9999,
  onlyStream: false,
  sort: 'score',
};

// Limites de ano a partir dos dados (se ajusta sozinho quando entrar o séc. XX)
const YEARS = M.map(m => m.year).filter(y => y != null);
const YMIN = Math.min(...YEARS), YMAX = Math.max(...YEARS);
state.yearMin = YMIN; state.yearMax = YMAX;
for (const el of [$('yearMin'), $('yearMax')]){ el.min = YMIN; el.max = YMAX; }
$('yearMin').value = YMIN; $('yearMax').value = YMAX;
function updateYearLabel(){
  $('yearVal').textContent = `${state.yearMin} – ${state.yearMax}`;
  const span = (YMAX - YMIN) || 1;
  const l = (state.yearMin - YMIN) / span * 100;
  const r = (state.yearMax - YMIN) / span * 100;
  $('yearFill').style.left = l + '%';
  $('yearFill').style.right = (100 - r) + '%';
}
updateYearLabel();

// ---- Populate selects ----
function uniqueSorted(arr){ return [...new Set(arr)].sort((a,b)=>a.localeCompare(b,'pt-BR')); }

uniqueSorted(M.flatMap(m => m.platforms)).forEach(p => $('platform').add(new Option(p, p)));
uniqueSorted(M.map(m => m.country)).forEach(c => $('country').add(new Option(c, c)));
uniqueSorted(M.map(m => m.director)).forEach(d => $('director').add(new Option(d, d)));
uniqueSorted(M.flatMap(m => m.genres)).forEach(g => $('genre').add(new Option(g, g)));

// ---- Filtering ----
function matches(m){
  if (state.q){
    const q = state.q.toLowerCase();
    const hay = (m.titleOrig + ' ' + m.titlePt + ' ' + m.director).toLowerCase();
    if (!hay.includes(q)) return false;
  }
  // UNIÃO: passa se aparece em ao menos uma lista marcada (nenhuma marcada = nada aparece)
  if (![...state.lists].some(k => k in m.ranks)) return false;
  if (state.platform && !m.platforms.includes(state.platform)) return false;
  if (state.country && m.country !== state.country) return false;
  if (state.director && m.director !== state.director) return false;
  if (state.genre && !m.genres.includes(state.genre)) return false;
  if (m.duration != null && m.duration > state.maxDur) return false;
  if (m.year != null && (m.year < state.yearMin || m.year > state.yearMax)) return false;
  if (state.onlyStream && m.platforms.length === 0) return false;
  return true;
}

function sortFn(a, b){
  switch(state.sort){
    // UNIÃO: soma de pontos (maior primeiro), desempate por menor média de posição.
    // Se só um instituto está marcado, ordena pela ordem publicada dele.
    case 'score': {
      if (state.lists.size === 1){
        const k = [...state.lists][0];
        return (a.ranks[k] ?? 9999) - (b.ranks[k] ?? 9999);
      }
      return (b.points - a.points) || ((a.avgRank ?? 9999) - (b.avgRank ?? 9999));
    }
    case 'gua': return (a.ranks.GUA ?? 9999) - (b.ranks.GUA ?? 9999);
    case 'nyt': return (a.ranks.NYT ?? 9999) - (b.ranks.NYT ?? 9999);
    case 'bbc': return (a.ranks.BBC ?? 9999) - (b.ranks.BBC ?? 9999);
    case 'titleOrig': return a.titleOrig.localeCompare(b.titleOrig,'pt-BR');
    case 'yearDesc': return (b.year ?? -1) - (a.year ?? -1);
    case 'yearAsc':  return (a.year ?? 9999) - (b.year ?? 9999);
    case 'durAsc':  return (a.duration ?? 9999) - (b.duration ?? 9999);
    case 'durDesc': return (b.duration ?? -1) - (a.duration ?? -1);
    default: return 0;
  }
}

// ---- Render ----
function badge(m){
  const keys = Object.keys(m.ranks);
  const label = k => (SRC[k] && SRC[k].label) || k;   // grafia única (Guardian/Times), single ou multi
  if (keys.length >= 2){
    const txt = keys.map(k => `${label(k)} #${m.ranks[k]}`).join(' · ');
    return `<span class="b both">${txt}</span>`;
  }
  const k = keys[0];
  const cls = { GUA:'gua', NYT:'nyt', BBC:'bbc' }[k] || 'nyt';
  return `<span class="b ${cls}">${label(k)} #${m.ranks[k]}</span>`;
}

function card(m){
  const plats = m.platforms.length
    ? m.platforms.map(p => `<span class="plat">${p}</span>`).join('')
    : `<span class="plat none">sem streaming BR</span>`;
  // Hierarquia: título em pt-BR primeiro e com mais peso; original abaixo, mais leve.
  const primary = m.titlePt || m.titleOrig;
  const orig = (m.titleOrig && m.titleOrig !== primary) ? `<div class="cpt">${m.titleOrig}</div>` : '';
  const genres = m.genres.length
    ? `<div class="genres">${m.genres.map(g => `<span class="gtag">${g}</span>`).join('')}</div>`
    : '';
  const poster = m.poster
    ? `<img class="poster" src="https://image.tmdb.org/t/p/w185${m.poster}" alt="Pôster de ${m.titleOrig}" loading="lazy">`
    : `<div class="poster none">sem pôster</div>`;
  const syn = m.overview
    ? `<div class="csyn"><p class="synopsis">${esc(m.overview)}</p></div>`
    : '';
  return `<article class="card">
    <div class="rankbar"></div>
    ${poster}
    <div class="cbody">
      <div class="ct">${primary}</div>
      ${orig}
      <div class="badges"><span class="b pts">★ ${m.points} pts</span>${badge(m)}</div>
      ${genres}
      <div class="meta">
        <span><b>${m.director}</b></span>
        ${m.year != null ? `<span>${m.year}</span>` : ''}
        <span>${m.country}</span>
        ${m.duration != null ? `<span>${m.duration} min</span>` : ''}
      </div>
      <div class="plats">${plats}</div>
    </div>
    ${syn}
  </article>`;
}

function render(){
  const list = M.filter(matches).sort(sortFn);
  $('n').textContent = list.length;
  grid.innerHTML = list.length
    ? list.map(card).join('')
    : `<div class="empty">Nenhum filme com esses filtros.</div>`;
}

// ---- Events ----
$('q').addEventListener('input', e => { state.q = e.target.value.trim(); render(); });

$('listChips').addEventListener('click', e => {
  const chip = e.target.closest('.chip'); if (!chip) return;
  const k = chip.dataset.list;
  if (state.lists.has(k)) state.lists.delete(k); else state.lists.add(k);
  chip.classList.toggle('on');
  render();
});

$('platform').addEventListener('change', e => { state.platform = e.target.value; render(); });
$('country').addEventListener('change', e => { state.country = e.target.value; render(); });
$('director').addEventListener('change', e => { state.director = e.target.value; render(); });
$('genre').addEventListener('change', e => { state.genre = e.target.value; render(); });
$('onlyStream').addEventListener('change', e => { state.onlyStream = e.target.checked; render(); });

$('dur').addEventListener('input', e => {
  state.maxDur = +e.target.value;
  $('durVal').textContent = state.maxDur >= 321 ? 'qualquer' : `até ${state.maxDur} min`;
  render();
});

$('yearMin').addEventListener('input', e => {
  let v = +e.target.value;
  if (v > state.yearMax){ v = state.yearMax; e.target.value = v; }
  state.yearMin = v; updateYearLabel(); render();
});
$('yearMax').addEventListener('input', e => {
  let v = +e.target.value;
  if (v < state.yearMin){ v = state.yearMin; e.target.value = v; }
  state.yearMax = v; updateYearLabel(); render();
});

$('sort').addEventListener('change', e => { state.sort = e.target.value; render(); });

$('reset').addEventListener('click', () => {
  Object.assign(state, { q:'', platform:'', country:'', director:'', genre:'', maxDur:321,
    yearMin:YMIN, yearMax:YMAX, onlyStream:false, sort:'score' });
  state.lists = new Set(ALL_LISTS);
  $('q').value=''; $('platform').value=''; $('country').value=''; $('director').value=''; $('genre').value='';
  $('dur').value=321; $('durVal').textContent='qualquer'; $('onlyStream').checked=false; $('sort').value='score';
  $('yearMin').value=YMIN; $('yearMax').value=YMAX; updateYearLabel();
  syncListChips();
  render();
});

// Reflect state.lists on the chip UI
function syncListChips(){
  document.querySelectorAll('#listChips .chip').forEach(c =>
    c.classList.toggle('on', state.lists.has(c.dataset.list)));
}

syncListChips();
render();

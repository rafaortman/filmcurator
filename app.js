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

// ---- Chips de lista (gerados das fontes; escala sozinho quando entra lista nova) ----
$('listChips').innerHTML = Object.entries(SRC)
  .map(([k, s]) => `<span class="chip" data-list="${k}">${s.label}</span>`).join('');

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
  // Clique no card → busca no Google ("onde assistir", que já embute JustWatch + YouTube)
  const q = `${m.titlePt || m.titleOrig} ${m.year ?? ''} assistir online`.trim();
  return `<article class="card" data-q="${esc(q)}">
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
// Clique no card abre a busca do Google numa nova aba (a menos que esteja selecionando texto)
grid.addEventListener('click', e => {
  if (String(window.getSelection())) return;      // usuário está selecionando a sinopse
  const cardEl = e.target.closest('.card'); if (!cardEl) return;
  const q = cardEl.dataset.q; if (!q) return;
  window.open('https://www.google.com/search?q=' + encodeURIComponent(q), '_blank', 'noopener');
});

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

// ---- Colapsar filtros (default fechado; no desktop o CSS mantém aberto) ----
const filtersEl = document.querySelector('.filters');
$('filtersToggle').addEventListener('click', () => {
  const collapsed = filtersEl.classList.toggle('collapsed');
  $('filtersToggle').setAttribute('aria-expanded', String(!collapsed));
});

// ---- Sorteio ----
const shuffleModal  = $('shuffleModal');
const shuffleResult = $('shuffleResult');
const selGenre = $('lockGenre');
const selPlat  = $('lockPlatform');
let currentDraw = null;    // filme sorteado atual (null = sem resultado)

// Opções dos selects de critério: todos os gêneros / plataformas da base.
uniqueSorted(M.flatMap(m => m.genres)).forEach(g => selGenre.add(new Option(g, g)));
uniqueSorted(M.flatMap(m => m.platforms)).forEach(p => selPlat.add(new Option(p, p)));

// Pool base respeita os filtros já aplicados na barra lateral.
const basePool = () => M.filter(matches);

// Pool do re-sorteio = base ∩ gênero fixado ∩ plataforma fixada.
function drawPool(){
  let pool = basePool();
  if (selGenre.value) pool = pool.filter(m => m.genres.includes(selGenre.value));
  if (selPlat.value)  pool = pool.filter(m => m.platforms.includes(selPlat.value));
  return pool;
}

const pickRandom = pool => pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;

function renderResult(){
  if (currentDraw){ shuffleResult.innerHTML = card(currentDraw); return; }
  // Sem resultado: base vazia = filtros da barra; senão = critérios dos selects.
  shuffleResult.innerHTML = basePool().length === 0
    ? `<div class="modal-msg">Nenhum filme com os filtros da barra lateral.<br>Feche o sorteio e ajuste os filtros para começar.</div>`
    : `<div class="modal-msg">Nenhum filme com esse gênero e plataforma.<br>Altere os critérios abaixo e sorteie de novo.
         <br><button type="button" class="reset" id="clearReroll">Limpar critérios</button></div>`;
}

function openShuffle(){
  selGenre.value = ''; selPlat.value = '';
  currentDraw = pickRandom(basePool());
  renderResult();
  shuffleModal.classList.add('open');
}
const closeShuffle = () => shuffleModal.classList.remove('open');

$('shuffle').addEventListener('click', openShuffle);
$('shuffleClose').addEventListener('click', closeShuffle);
shuffleModal.addEventListener('click', e => { if (e.target === shuffleModal) closeShuffle(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeShuffle(); });

// Sortear de novo respeita gênero + plataforma fixados (interseção); vazio → tela de sem-resultados.
$('shuffleAgain').addEventListener('click', () => {
  currentDraw = pickRandom(drawPool());
  renderResult();
});

// Cliques no resultado: "Limpar critérios" · card (busca no Google).
shuffleResult.addEventListener('click', e => {
  if (e.target.closest('#clearReroll')){
    selGenre.value = ''; selPlat.value = '';
    currentDraw = pickRandom(basePool());
    renderResult();
    return;
  }
  const cardEl = e.target.closest('.card');
  if (cardEl && cardEl.dataset.q && !String(window.getSelection())){
    window.open('https://www.google.com/search?q=' + encodeURIComponent(cardEl.dataset.q), '_blank', 'noopener');
  }
});

// ---- Footer: data de atualização = checagem de streaming mais recente ----
(() => {
  const el = $('updated'); if (!el) return;
  const dates = M.map(m => m.streamingCheckedAt).filter(Boolean).sort();
  if (!dates.length) return;
  const [y, mo, d] = dates[dates.length - 1].split('-');
  el.textContent = `Streamings atualizados em ${d}/${mo}/${y}`;
})();

"""
Enriquecimento incremental via TMDB (versionado, idempotente, econômico em contexto).

Fluxo:
  1) Lê uma lista bruta (ex.: lists/rollingstone.txt) -> parse (rank, título, ano, diretor).
  2) Resolve cada filme no TMDB (busca + detalhes), com CACHE em disco (.cache/tmdb/).
  3) Monta a linha no schema do films.csv (país pt-BR, gênero pt-BR, streaming BR flatrate).
  4) Dedup: por tmdb_id exato contra TODA a base (qualquer era). Id é único por filme,
     então XX e XXI nunca colidem entre si; um filme já cadastrado só ganha +ranking.
  5) DRY-RUN (default): NÃO grava nada; escreve um CSV de revisão humana e imprime só RESUMO.
     --commit: grava em films.csv/rankings.csv/sources.json e chama build_data.py.

Uso:
  python enrich.py lists/rollingstone.txt --source ROL            # dry-run
  python enrich.py lists/rollingstone.txt --source ROL --commit   # grava

Objetivo de contexto: o resumo impresso é minúsculo; os 100 detalhes vão pro CSV de
revisão (que NÃO precisa ser lido pra dentro do chat).
"""
import csv, json, os, re, sys, time, urllib.parse, urllib.request, hashlib, unicodedata
from datetime import date

# console do Windows é cp1252 e quebra em títulos acentuados; força UTF-8 na saída
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(ROOT, ".cache", "tmdb")
os.makedirs(CACHE, exist_ok=True)
TODAY = date.today().isoformat()
API = "https://api.themoviedb.org/3"

# ---- chave (.env) ----
def load_key():
    for line in open(os.path.join(ROOT, ".env"), encoding="utf-8"):
        line = line.strip()
        if line.startswith("TMDB_API_KEY"):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    sys.exit("TMDB_API_KEY não encontrada no .env")
KEY = load_key()

# ---- país iso -> pt-BR (casando convenção existente em films.csv) ----
COUNTRY = {
    "US":"EUA","GB":"Reino Unido","FR":"França","IT":"Itália","DE":"Alemanha",
    "JP":"Japão","KR":"Coreia do Sul","HK":"Hong Kong","TW":"Taiwan","CN":"China",
    "IN":"Índia","RU":"Rússia","SU":"Rússia","SE":"Suécia","DK":"Dinamarca","NO":"Noruega",
    "PL":"Polônia","AT":"Áustria","BE":"Bélgica","ES":"Espanha","MX":"México",
    "AR":"Argentina","BR":"Brasil","CA":"Canadá","IE":"Irlanda","NZ":"Nova Zelândia",
    "AU":"Austrália","GR":"Grécia","HU":"Hungria","RO":"Romênia","TR":"Turquia",
    "IR":"Irã","IL":"Israel","LB":"Líbano","TH":"Tailândia","CH":"Suíça","NL":"Holanda",
    "PT":"Portugal","MR":"Mauritânia","BF":"Burquina Faso","CM":"Camarões","MA":"Marrocos",
    "SN":"Senegal","TN":"Tunísia","CZ":"Tchéquia","CS":"Tchecoslováquia","FI":"Finlândia",
    "IS":"Islândia","CU":"Cuba","CL":"Chile","CO":"Colômbia","PE":"Peru",
}
UNMAPPED_COUNTRIES = set()

# ---- normalização de provedores de streaming (ver memória tmdb-enrichment) ----
def norm_provider(name):
    n = name.replace(" Amazon Channel", "").replace(" Apple TV Channel", "")
    n = n.replace("Amazon Prime Video", "Prime Video").replace("Prime Video with Ads", "Prime Video")
    n = n.replace("Paramount Plus", "Paramount+").replace("Paramount+ Amazon Channel", "Paramount+")
    n = n.replace("Standard with Ads", "").replace(" Premium", "").strip()
    return n

# ---- HTTP com cache em disco ----
def get(path, params):
    params = {**params, "api_key": KEY}
    url = f"{API}{path}?{urllib.parse.urlencode(params)}"
    ck = hashlib.md5(url.encode()).hexdigest() + ".json"
    cp = os.path.join(CACHE, ck)
    if os.path.exists(cp):
        return json.load(open(cp, encoding="utf-8"))
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=20) as r:
                data = json.load(r)
            json.dump(data, open(cp, "w", encoding="utf-8"), ensure_ascii=False)
            time.sleep(0.25)  # gentil com a API
            return data
        except Exception as e:
            if attempt == 3:
                raise
            time.sleep(1 + attempt)

# ---- parse da lista bruta ----
def parse_list(fp):
    entries = []
    for raw in open(fp, encoding="utf-8"):
        raw = raw.strip()
        if not raw:
            continue
        m = re.match(r"^\s*(\d+)\.\s*(.+)$", raw)
        if not m:
            continue
        rank = int(m.group(1)); rest = m.group(2).strip()
        year = None; directors = []
        parens = re.findall(r"\(([^()]*)\)", rest)   # todos os grupos entre parênteses
        if parens:
            # título = antes do 1º "("; meta = ÚLTIMO parêntese (ano [, diretor]).
            # ignora parênteses do meio (ex.: título original alternativo).
            title = rest.split("(", 1)[0].strip()
            meta = parens[-1].strip()
            ym = re.match(r"^\s*(\d{4})", meta)          # ano no início (tolera "1967." e "1967,")
            if ym:
                year = int(ym.group(1)); meta = meta[ym.end():]
            meta = meta.lstrip(" ,.;")
            # só trata como diretor se sobrar texto com letras (evita "-16" de "1915-16")
            if re.search(r"[A-Za-z]", meta):
                # divide diretores por vírgula, "and" e "&"
                directors = [d.strip() for d in re.split(r",|\band\b|&", meta) if d.strip()]
        else:
            title = rest
        entries.append({"rank": rank, "title": title, "year": year, "directors": directors})
    return entries

# ---- resolução TMDB ----
# Overrides curados p/ casos que a busca não resolve (título TMDB difere do da lista).
# id-map persistente: cresce conforme aparecem casos difíceis.
OVERRIDE = {
    "the bicycle thief": 5156,   # Ladri di biciclette (De Sica, 1948)
    "breathless": 269,           # À bout de souffle (Godard, 1960)
}

def _deaccent(s):
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))

def _name_tokens(name):
    return re.sub(r"[^\w\s]", " ", _deaccent(name).lower()).split()

def director_matches(wanted, credited):
    """Casa nome ignorando acento e variações: mesmo sobrenome + mesma inicial do 1º nome."""
    for w in wanted:
        wt = _name_tokens(w)
        if not wt:
            continue
        for c in credited:
            ct = _name_tokens(c)
            if ct and wt[-1] == ct[-1] and wt[0][0] == ct[0][0]:
                return True
    return False

def resolve(title, year, directors):
    """Retorna (tmdb_id, motivo) ou (None, motivo). NUNCA chuta quando há diretor."""
    key = title.lower().strip()
    if key in OVERRIDE:
        return OVERRIDE[key], "override"
    # busca: ano exato, depois ±1 (anos de lista costumam divergir do TMDB), depois sem ano
    res = []
    for y in ([year, year + 1, year - 1] if year else [None]):
        params = {"query": title, "language": "pt-BR"}
        if y:
            params["year"] = y
        res = get("/search/movie", params).get("results", [])
        if res:
            break
    if not res:
        return None, "não encontrado"
    if directors:
        for cand in res[:10]:
            cr = get(f"/movie/{cand['id']}/credits", {}).get("crew", [])
            dirs = [c["name"] for c in cr if c.get("job") == "Director"]
            if director_matches(directors, dirs):
                return cand["id"], "ok (diretor)"
        # diretor informado mas nenhum candidato bateu: NÃO chutar, mandar p/ revisão
        return None, "diretor não confere"
    return res[0]["id"], "TÍTULO-ONLY (verificar)"

def build_row(tmdb_id):
    d = get(f"/movie/{tmdb_id}", {"language": "pt-BR",
            "append_to_response": "credits,external_ids,watch/providers"})
    yr = int(d["release_date"][:4]) if d.get("release_date") else None
    era = "XX" if (yr and yr <= 1999) else "XXI"
    genres = [g["name"] for g in d.get("genres", [])]
    countries = []
    for c in d.get("production_countries", []):
        code = c["iso_3166_1"]
        if code in COUNTRY:
            countries.append(COUNTRY[code])
        else:
            UNMAPPED_COUNTRIES.add(f"{code}={c.get('name')}")
            countries.append(c.get("name"))
    director = next((c["name"] for c in d.get("credits", {}).get("crew", []) if c.get("job") == "Director"), "")
    wp = d.get("watch/providers", {}).get("results", {}).get("BR", {}).get("flatrate", [])
    plats = sorted({norm_provider(p["provider_name"]) for p in wp})
    return {
        "id": str(tmdb_id),
        "imdb_id": d.get("external_ids", {}).get("imdb_id", "") or "",
        "title_orig": d.get("original_title", ""),
        "title_pt": d.get("title", ""),
        "year": yr or "",
        "country": " / ".join(countries),
        "director": director,
        "duration": d.get("runtime") or "",
        "genres": ";".join(genres),
        "poster_path": d.get("poster_path") or "",
        "overview": (d.get("overview") or "").replace("\n", " ").strip(),
        "era": era,
        "streaming": ";".join(plats),
        "streaming_checked_at": TODAY,
    }

# ---- casos especiais (coleções que viram >1 filme) ----
SPECIAL = {
    "the godfather trilogy": [(238, 1), (240, 1)],  # I (1972) + II (1974), mesmo rank
}
COLLECTION_KW = re.compile(r"\b(trilogy|collection|saga|series)\b", re.I)
# títulos a ignorar de propósito (não existem como FILME no TMDB, etc.)
SKIP = {
    "berlin alexanderplatz": "minissérie de TV (Fassbinder), não é filme no TMDB",
}

def main():
    if len(sys.argv) < 2:
        sys.exit("uso: python enrich.py <lista.txt> [--source XXX] [--commit]")
    list_fp = os.path.join(ROOT, sys.argv[1])
    source = "ROL"
    if "--source" in sys.argv:
        source = sys.argv[sys.argv.index("--source") + 1]
    commit = "--commit" in sys.argv

    # base existente
    films = list(csv.DictReader(open(os.path.join(ROOT, "films.csv"), encoding="utf-8")))
    existing_ids = {r["id"] for r in films}
    header = list(films[0].keys())

    entries = parse_list(list_fp)
    new_rows, rank_rows = [], []
    crossovers, needs_review, title_only, added = [], [], [], set()

    for e in entries:
        key = e["title"].lower().strip()
        if key in SKIP:
            needs_review.append(f"#{e['rank']} {e['title']} (ignorado — {SKIP[key]})")
            continue
        if key in SPECIAL:
            for tid, rk in SPECIAL[key]:
                row = build_row(tid)
                if row["id"] not in existing_ids and row["id"] not in added:
                    new_rows.append(row); added.add(row["id"])
                rank_rows.append((row["id"], source, rk))
            continue
        if COLLECTION_KW.search(e["title"]):
            needs_review.append(f"#{e['rank']} {e['title']} (coleção — tratar caso a caso)")
            continue
        try:
            tid, reason = resolve(e["title"], e["year"], e["directors"])
        except Exception as ex:
            needs_review.append(f"#{e['rank']} {e['title']} (erro: {ex})")
            continue
        if not tid:
            needs_review.append(f"#{e['rank']} {e['title']} ({reason})")
            continue
        row = build_row(tid)
        if "TÍTULO-ONLY" in reason:
            title_only.append(f"#{e['rank']} {e['title']} -> {row['title_pt']} ({row['year']}) tmdb {tid}")
        # dedup por tmdb_id contra toda a base (qualquer era)
        if row["id"] in existing_ids:
            crossovers.append(f"#{e['rank']} {row['title_pt']} ({row['year']}) — já na base, +ranking")
            rank_rows.append((row["id"], source, e["rank"]))
            continue
        if row["id"] not in existing_ids and row["id"] not in added:
            new_rows.append(row); added.add(row["id"])
        rank_rows.append((row["id"], source, e["rank"]))

    # ---- RESUMO (o que vai pro contexto) ----
    print("=" * 60)
    print(f"LISTA: {sys.argv[1]}  | fonte: {source}  | modo: {'COMMIT' if commit else 'DRY-RUN'}")
    print(f"Entradas parseadas: {len(entries)}")
    print(f"Filmes NOVOS a cadastrar: {len(new_rows)}")
    print(f"Crossovers (já na base, só +ranking): {len(crossovers)}")
    print(f"Linhas de ranking a gravar: {len(rank_rows)}")
    sc = sum(1 for r in new_rows if r['streaming'])
    print(f"Novos COM streaming BR: {sc}  | SEM: {len(new_rows)-sc}")
    print(f"Sem pôster: {sum(1 for r in new_rows if not r['poster_path'])}")
    if crossovers:
        print("\n-- CROSSOVERS --"); [print("  " + c) for c in crossovers]
    if title_only:
        print(f"\n-- RESOLVIDOS SÓ POR TÍTULO ({len(title_only)}) — conferir --")
        [print("  " + t) for t in title_only]
    if needs_review:
        print(f"\n-- PRECISA REVISÃO ({len(needs_review)}) --")
        [print("  " + n) for n in needs_review]
    if UNMAPPED_COUNTRIES:
        print(f"\n-- PAÍSES FORA DO MAPA (adicionar em COUNTRY) --")
        [print("  " + c) for c in sorted(UNMAPPED_COUNTRIES)]

    # CSV de revisão humana (NÃO precisa ser lido no chat)
    rev = os.path.join(ROOT, "lists", os.path.splitext(os.path.basename(list_fp))[0] + ".resolved.csv")
    with open(rev, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=header); w.writeheader(); w.writerows(new_rows)
    print(f"\nDetalhe dos novos -> {os.path.relpath(rev, ROOT)}  (abra pra revisar)")

    if not commit:
        print("\nDRY-RUN: nada foi gravado. Rode com --commit após revisar.")
        return

    # ---- COMMIT: grava ----
    with open(os.path.join(ROOT, "films.csv"), "a", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=header)
        for r in new_rows: w.writerow(r)
    with open(os.path.join(ROOT, "rankings.csv"), "a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        for fid, s, rk in rank_rows: w.writerow([fid, s, rk])
    print(f"\nGRAVADO: +{len(new_rows)} filmes, +{len(rank_rows)} rankings. Rode build_data.py.")

if __name__ == "__main__":
    main()

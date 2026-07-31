"""
Gera data.js (consumido pelo index.html) a partir das fontes limpas:
  - films.csv     : um filme por linha (metadados + IDs + streaming)
  - rankings.csv  : uma linha por (filme, lista, posição)
  - sources.json  : metadados/legenda das listas

Fórmula de consenso (sem sentinela 999):
  1) n_lists  = em quantas listas o filme aparece  (mais = melhor)
  2) avg_rank = média das posições onde aparece     (menor = melhor, desempate)

Rode:  python build_data.py
"""
import csv, json, os
from collections import defaultdict

ROOT = os.path.dirname(os.path.abspath(__file__))

def read_csv(name):
    with open(os.path.join(ROOT, name), encoding="utf-8") as f:
        return list(csv.DictReader(f))

films = read_csv("films.csv")
rankings = read_csv("rankings.csv")
sources = json.load(open(os.path.join(ROOT, "sources.json"), encoding="utf-8"))

# rankings por filme: {film_id: {source: rank}}
by_film = defaultdict(dict)
for r in rankings:
    by_film[r["film_id"]][r["source"]] = int(r["rank"])

# tamanho publicado de cada lista (maior posição) -> escala de pontos por lista
list_size = defaultdict(int)
for r in rankings:
    list_size[r["source"]] = max(list_size[r["source"]], int(r["rank"]))

movies = []
for f in films:
    ranks = by_film.get(f["id"], {})
    n_lists = len(ranks)
    avg_rank = round(sum(ranks.values()) / n_lists, 1) if n_lists else None
    # UNIÃO: pontos = soma de (tamanho_da_lista - posição + 1). #1 ~= tamanho, ausente = 0.
    points = sum(list_size[s] - rank + 1 for s, rank in ranks.items())
    movies.append({
        "id": f["id"],
        "imdb_id": f["imdb_id"],
        "titleOrig": f["title_orig"],
        "titlePt": f["title_pt"],
        "year": int(f["year"]) if f["year"] else None,
        "country": f["country"],
        "director": f["director"],
        "duration": int(f["duration"]) if f["duration"] else None,
        "genres": [g.strip() for g in f.get("genres", "").split(";") if g.strip()],
        "poster": f.get("poster_path", ""),   # caminho TMDB (ex.: /abc.jpg); URL montada no app
        "overview": f.get("overview", ""),     # sinopse pt-BR (fallback en) — accordion "Leia mais"
        "era": f["era"],
        "platforms": [p.strip() for p in f["streaming"].split(";") if p.strip()],
        "streamingCheckedAt": f["streaming_checked_at"],
        "ranks": ranks,          # ex.: {"GUA": 1, "NYT": 3}
        "nLists": n_lists,
        "avgRank": avg_rank,
        "points": points,        # UNIÃO: ordenação padrão
    })

payload = {"sources": sources, "movies": movies}
out = os.path.join(ROOT, "data.js")
with open(out, "w", encoding="utf-8") as f:
    f.write("window.DB = " + json.dumps(payload, ensure_ascii=False, indent=0) + ";")

print(f"data.js gerado: {len(movies)} filmes, {len(sources)} fontes.")

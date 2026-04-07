(() => {
  // ========== CONFIG ==========
  const REGOLAMENTO_ROOT = '#regolamento';
  const MAX_RESULTS = 8;

  // Stopwords ITA (riduce rumore)
  const stop = new Set([
    "il","lo","la","i","gli","le","un","uno","una","di","del","dello","della","dei","degli","delle",
    "a","al","allo","alla","ai","agli","alle","da","dal","dallo","dalla","dai","dagli","dalle",
    "in","nel","nello","nella","nei","negli","nelle","su","sul","sullo","sulla","sui","sugli","sulle",
    "per","tra","fra","che","e","o","ma","se","come","cosa","quando","dove","quale","quali","quanto",
    "sono","sia","essere","viene","vengono","fare","fatto","fai","fa","chi","cui"
  ]);

  // Sinonimi / espansioni “Fantacalcio”
  const synonyms = {
    "formazione": ["schieramento","lineup"],
    "consegna": ["inserimento","invio"],
    "mancata": ["assenza","non"],
    "tavolino": ["3-0","tre a zero","a tavolino"],
    "scambi": ["scambio","trade"],
    "gennaio": ["mese di gennaio"],
    "sforamento": ["supero","oltre","negativo","credito negativo"],
    "crediti": ["budget","fondi","soldi"],
    "rinviate": ["rinvio","recupero","posticipo"],
    "recupero": ["rinviata","rinviate"],
    "politico": ["6","sei politico"],
    "sanzioni": ["penalità","punti tolti","punizioni"]
  };

  function normalize(s){
    return (s || "")
      .toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
      .replace(/[^\p{L}\p{N}\s-]/gu," ")
      .replace(/\s+/g," ")
      .trim();
  }

  function tokenize(s){
    const base = normalize(s).split(" ").filter(w => w && !stop.has(w) && w.length > 1);
    const expanded = [];
    for(const w of base){
      expanded.push(w);
      if (synonyms[w]) expanded.push(...synonyms[w].map(normalize));
    }
    // “boost” per query naturali comuni
    const t = normalize(s);
    if (/non.*consegn.*formazione|mancat.*formazione/.test(t)) {
      expanded.push("formazione","consegna","tavolino","60","3-0","sconfitta");
    }
    if (/scambi.*gennaio|gennaio.*scambi/.test(t)) expanded.push("scambi","gennaio");
    if (/sforamento|credito negativo|supero.*crediti|oltre.*crediti/.test(t)) expanded.push("sforamento","crediti","penalità");
    if (/rinvi|recuper/.test(t)) expanded.push("rinviate","recupero","10","politico","6");

    return [...new Set(expanded)];
  }

  function fuzzyScore(term, text){
    if (!term) return 0;
    if (text.includes(term)) return 3;
    const parts = text.split(" ");
    for(const p of parts){
      if (p.startsWith(term)) return 2;
    }
    return 0;
  }

  function esc(s){
    return String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }

  // ========== INDEX ==========
  // Ogni item: {kind:'art'|'sum', artNum?, sectionTitle, text, node, outerDetails, innerDetails}
  const index = [];

  function buildIndex(){
    index.length = 0;
    const root = document.querySelector(REGOLAMENTO_ROOT);
    if (!root) return;

    const topSections = root.querySelectorAll(':scope > details');

    topSections.forEach(sec => {
      const secSummary = sec.querySelector(':scope > summary');
      const sectionTitle = secSummary ? secSummary.innerText.replace("⌄","").trim() : "Sezione";

      // 1) indicizza il riassunto (primo <p> dentro .content)
      const outerContent = sec.querySelector(':scope > .content');
      if (outerContent){
        const firstP = outerContent.querySelector(':scope > p');
        if (firstP){
          if (!firstP.id) firstP.id = `sum-${Math.random().toString(16).slice(2)}`;
          index.push({
            kind: 'sum',
            sectionTitle,
            text: firstP.innerText.trim(),
            node: firstP,
            outerDetails: sec,
            innerDetails: null
          });
        }
      }

      // 2) indicizza gli articoli: tutti i <p> dentro il details interno (📜)
      const innerDetails = sec.querySelector(':scope > .content details'); // il primo details interno
      const innerContent = innerDetails?.querySelector(':scope > .content');
      if (innerContent){
        innerContent.querySelectorAll('p').forEach(p => {
          const raw = p.innerText.trim();
          if (!raw) return;

          const m = raw.match(/Art\.\s*(\d+)/i);
          const artNum = m ? parseInt(m[1],10) : null;

          if (!p.id) p.id = artNum ? `art-${artNum}` : `artx-${Math.random().toString(16).slice(2)}`;

          index.push({
            kind: 'art',
            artNum,
            sectionTitle,
            text: raw,
            node: p,
            outerDetails: sec,
            innerDetails
          });
        });
      }
    });
  }

  // ========== UI ==========
  function highlightSnippet(text, terms){
    let snip = text;
    if (snip.length > 220) snip = snip.slice(0, 220) + "…";
    const t = terms.slice(0,6).sort((a,b)=>b.length-a.length);
    for(const k of t){
      if (k.length < 2) continue;
      const re = new RegExp(`(${k.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')})`,'ig');
      snip = snip.replace(re, '<mark>$1</mark>');
    }
    return snip;
  }

  function scoreItem(item, qTokens, rawQuery){
    const text = normalize(item.text + " " + item.sectionTitle);
    let score = 0;

    for(const t of qTokens) score += fuzzyScore(t, text);

    // Bonus: se l’utente cerca “Art 19”
    const artNum = (rawQuery.match(/\bart\.?\s*(\d{1,2})\b/i) || rawQuery.match(/\b(\d{1,2})\b/))?.[1];
    if (artNum && item.kind === 'art' && item.artNum === parseInt(artNum,10)) score += 10;

    // Bonus per match “forti”
    if (item.kind === 'art' && text.includes("sconfitta") && qTokens.includes("formazione")) score += 2;
    if (item.kind === 'art' && text.includes("gennaio") && qTokens.includes("scambi")) score += 2;

    // Leggero boost agli articoli rispetto ai riassunti
    if (item.kind === 'art') score += 1;

    return score;
  }

  function openAndScroll(item){
    if (item.outerDetails) item.outerDetails.open = true;
    if (item.innerDetails) item.innerDetails.open = true;
    item.node.scrollIntoView({ behavior:"smooth", block:"center" });
    item.node.classList.add("flash");
    setTimeout(()=> item.node.classList.remove("flash"), 950);
  }

  function wireSearchUI(){
    const input = document.getElementById('searchInput');
    const resultsBox = document.getElementById('searchResults');
    const meta = document.getElementById('searchMeta');
    const clearBtn = document.getElementById('clearSearch');

    if (!input || !resultsBox || !meta) {
      console.warn("Search UI missing: aggiungi searchInput/searchResults/searchMeta nel DOM.");
      return;
    }

    function doSearch(){
      const q = input.value.trim();
      if (!q){
        resultsBox.style.display = "none";
        meta.style.display = "none";
        resultsBox.innerHTML = "";
        return;
      }

      const qTokens = tokenize(q);

      const scored = index
        .map(it => ({ it, score: scoreItem(it, qTokens, q) }))
        .filter(x => x.score > 0)
        .sort((a,b) => b.score - a.score)
        .slice(0, MAX_RESULTS);

      meta.style.display = "block";
      meta.textContent = scored.length
        ? `Risultati: ${scored.length} • Tip: prova anche “Art. 19”, “scambi gennaio”, “sforamento crediti”.`
        : `Nessun risultato. Prova con: “formazione”, “scambi”, “crediti”, “rinviate”.`;

      if (!scored.length){
        resultsBox.style.display = "none";
        resultsBox.innerHTML = "";
        return;
      }

      resultsBox.style.display = "block";
      resultsBox.innerHTML = scored.map(({it}) => {
        const badge = it.kind === 'art' && it.artNum ? `Art. ${it.artNum}` : "Riassunto";
        return `
          <div class="resultItem" role="button" tabindex="0" data-target="${esc(it.node.id)}">
            <div class="resultTop">
              <div class="resultBadge">${esc(badge)}</div>
              <div class="resultTitle">${esc(it.sectionTitle)}</div>
            </div>
            <div class="resultSnippet">${highlightSnippet(esc(it.text), tokenize(q))}</div>
          </div>
        `;
      }).join("");

      resultsBox.querySelectorAll('.resultItem').forEach(el => {
        const id = el.getAttribute('data-target');
        const found = index.find(x => x.node.id === id);
        const go = () => found && openAndScroll(found);

        el.addEventListener('click', go);
        el.addEventListener('keydown', (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
        });
      });
    }

    document.querySelectorAll('.chip').forEach(btn => {
      btn.addEventListener('click', () => {
        input.value = btn.getAttribute('data-q') || '';
        doSearch();
        input.focus();
      });
    });

    clearBtn?.addEventListener('click', () => {
      input.value = "";
      doSearch();
      input.focus();
    });

    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k'){
        e.preventDefault();
        input.focus();
      }
    });

    input.addEventListener('input', doSearch);
  }

  // ========== START ==========
  function start(){
    buildIndex();
    wireSearchUI();
    // Debug utile: se è 0, la pagina non sta indicizzando nulla
    console.log("[Butliga Search] Indexed items:", index.length);
  }

  if (document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();

// Bibliothèque FSGGB : parcourir, chercher, lire et télécharger les documents du dossier Drive (via le serveur Apps Script de ce dépôt).
(() => {
  "use strict";
  const { $, say } = Hub;
  const TYPES = { pdf: "PDF", image: "Image", document: "Document", tableur: "Tableur", diaporama: "Diaporama", video: "Vidéo", audio: "Audio", texte: "Texte", fichier: "Fichier" };
  const fmt = n => !n ? "" : n < 1024 ? n + " o" : n < 1048576 ? (n / 1024).toFixed(0) + " Ko" : (n / 1048576).toFixed(1) + " Mo";
  const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  const ic = (n, c = "") => `<svg class="ic ${c}"><use href="#i-${n}"/></svg>`;
  let mode = (() => { try { return localStorage.getItem("biblio.mode") || "grid"; } catch { return "grid"; } })(), current = "", timer = 0, viewing = null;

  async function call(action, data = {}) {
    const API = window.BIBLIO_API; if (!API) throw new Error("La bibliothèque sera bientôt disponible.");
    let res; try { res = await fetch(API, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ action, token: Hub.token, ...data }) }); } catch { throw new Error("Serveur injoignable."); }
    let out; try { out = await res.json(); } catch { throw new Error("Réponse invalide du serveur."); }
    if (!out.ok) { if (/Session expirée|Connexion requise/.test(out.error)) { Hub.store.set(null); showGate(); } throw new Error(out.error || "Erreur."); }
    return out;
  }
  function showGate() { $("lib").hidden = true; $("gate").hidden = false; }

  function fileCard(f, searching) {
    const b = el("button", { className: "file", type: "button" }, el("span", { className: "ico", innerHTML: ic(f.type) }),
      el("span", {}, el("b", { textContent: f.nom }), el("small", { innerHTML: esc(TYPES[f.type] || "Fichier") + (f.taille ? " · " + fmt(f.taille) : "") + (searching && f.dossier ? ' · <span class="where">' + esc(f.dossier) + "</span>" : "") + (f.trouve === "contenu" ? " · dans le texte" : "") })));
    b.onclick = () => open(f); return b;
  }
  const esc = t => String(t == null ? "" : t).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function setMode(m) { mode = m; try { localStorage.setItem("biblio.mode", m); } catch {} $("v-grid").setAttribute("aria-pressed", String(m === "grid")); $("v-list").setAttribute("aria-pressed", String(m === "list")); $("files").className = "files " + m; }

  async function browse(id = "") {
    current = id; $("q").value = ""; say($("status"), "Chargement…"); $("folders").textContent = ""; $("files").textContent = "";
    try {
      const o = await call("liste", { dossier: id });
      const nav = $("crumbs"); nav.textContent = "";
      o.chemin.forEach((c, i) => { if (i) nav.insertAdjacentHTML("beforeend", ic("chev")); if (i === o.chemin.length - 1) nav.append(el("b", { textContent: c.nom })); else { const b = el("button", { type: "button", textContent: c.nom }); b.onclick = () => browse(i ? c.id : ""); nav.append(b); } });
      o.dossiers.forEach(d => { const b = el("button", { className: "folder", type: "button" }, el("span", { className: "ico", innerHTML: ic("folder") }), el("span", {}, el("b", { textContent: d.nom }), el("small", { textContent: d.n + " document" + (d.n > 1 ? "s" : "") }))); b.onclick = () => browse(d.id); $("folders").append(b); });
      o.fichiers.forEach(f => $("files").append(fileCard(f)));
      say($("status"), !o.dossiers.length && !o.fichiers.length ? "Ce dossier est vide." : "");
    } catch (e) { say($("status"), e.message, true); }
  }
  async function search(q) {
    $("folders").textContent = ""; $("files").textContent = ""; say($("status"), "Recherche…");
    try {
      const { documents } = await call("chercher", { requete: q });
      documents.forEach(f => $("files").append(fileCard(f, true)));
      say($("status"), documents.length ? documents.length + " résultat" + (documents.length > 1 ? "s" : "") : "Aucun document ne correspond à « " + q + " ».");
    } catch (e) { say($("status"), e.message, true); }
  }
  $("q").addEventListener("input", () => { clearTimeout(timer); const q = $("q").value.trim(); timer = setTimeout(() => q.length >= 2 ? search(q) : browse(current), 350); });
  $("v-grid").onclick = () => setMode("grid"); $("v-list").onclick = () => setMode("list");

  // ---------- lecture : aperçu dans la page, téléchargement ----------
  const bytes = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  let blobUrl = "";
  async function open(f) {
    viewing = { f, data: null }; const body = $("v-body"); body.textContent = ""; body.append(el("p", { textContent: "Chargement…" })); $("v-title").textContent = f.nom;
    $("v-ask").href = "/ScoutHub/ChatGDB/?q=" + encodeURIComponent("Dans le document « " + f.nom + " » de la bibliothèque, ");
    $("viewer").showModal();
    try {
      const d = viewing.data = await call("telecharger", { id: f.id });
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      const blob = new Blob([bytes(d.base64)], { type: d.mime }); blobUrl = URL.createObjectURL(blob); body.textContent = "";
      if (d.mime === "application/pdf") body.append(el("iframe", { src: blobUrl, title: d.nom }));
      else if (/^image\//.test(d.mime)) body.append(el("img", { src: blobUrl, alt: d.nom }));
      else if (/^text\//.test(d.mime)) body.append(el("pre", { textContent: new TextDecoder().decode(bytes(d.base64)) }));
      else body.append(el("p", { textContent: "Pas d’aperçu pour ce type de fichier : utilisez « Télécharger »." }));
    } catch (e) { body.textContent = ""; body.append(el("p", { textContent: e.message })); }
  }
  $("v-dl").onclick = () => { if (!viewing || !viewing.data) return; const a = el("a", { href: blobUrl, download: viewing.data.nom }); document.body.append(a); a.click(); a.remove(); };
  $("v-close").onclick = () => $("viewer").close();
  $("viewer").addEventListener("click", e => { if (e.target.id === "viewer") e.target.close(); });
  $("viewer").addEventListener("close", () => { $("v-body").textContent = ""; });

  // ---------- démarrage ----------
  setMode(mode);
  if (!Hub.token) showGate();
  else { $("lib").hidden = false; Hub.call("me").then(o => { Hub.user = o.user; Hub.cacheUser(o.user); }).catch(() => { Hub.store.set(null); showGate(); }); browse(); }
})();

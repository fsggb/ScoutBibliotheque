/**
 * ScoutBibliotheque : serveur Apps Script de la bibliothèque de documents de la fédération.
 *
 * Il lit un dossier Google Drive (l'arborescence devient les rubriques de la bibliothèque) ; le site statique de ce dépôt n'a
 * accès qu'à ce que ce serveur laisse passer. Exécuter « en tant que moi » : le compte qui déploie doit pouvoir lire le dossier.
 *
 * Propriétés du script (Paramètres du projet > Propriétés du script) :
 *   BIBLIO_DOSSIER : identifiant du dossier Drive racine (la fin de son adresse dans Drive).
 *   SCOUTHUB_API   : adresse /exec du serveur ScoutHub, qui vérifie les sessions (action « me »).
 *   CLE_PARTAGEE   : (facultatif) mot de passe partagé avec ChatGDB (même valeur que BIBLIO_CLE côté ScoutHub) : ChatGDB peut alors
 *                    chercher et lire les documents pour répondre aux questions.
 *
 * Accès par rubrique : dans la description d'un dossier Drive, écrire une ligne « acces: chef_unite » (membre, parent, chef_unite,
 * chef_groupe ou admin) pour réserver ce dossier et tout ce qu'il contient à ce rôle et aux rôles supérieurs. Sans ligne : tous les comptes.
 * Un dossier dont le nom commence par « _ » est ignoré.
 */
var ROLES = ['membre', 'parent', 'chef_unite', 'chef_groupe', 'admin'];
var MAX_FICHIERS = 3000, MAX_OCTETS = 8 * 1024 * 1024, DUREE_INDEX = 600;

function doGet() { return ContentService.createTextOutput(JSON.stringify({ ok: true, service: 'ScoutBibliotheque' })).setMimeType(ContentService.MimeType.JSON); }
function doPost(e) {
  try {
    var r = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var f = ACTIONS[r.action];
    if (!f) return json_({ ok: false, error: 'Action inconnue.' });
    return json_(f(r, acces_(r)));
  } catch (err) { return json_({ ok: false, error: err && err.userMessage ? err.userMessage : 'Erreur du serveur.' }); }
}
var ACTIONS = {
  liste: function (r, a) {
    var idx = index_(), id = r.dossier || idx.racine, d = idx.dossiers[id];
    if (!d || !permis_(d.min, a)) fail_('Dossier introuvable.');
    var chemin = [], c = d;
    while (c) { chemin.unshift({ id: c.id, nom: c.id === idx.racine ? 'Bibliothèque' : c.nom }); c = c.parent ? idx.dossiers[c.parent] : null; }
    var dossiers = [], fichiers = [];
    Object.keys(idx.dossiers).forEach(function (k) { var x = idx.dossiers[k]; if (x.parent === id && permis_(x.min, a)) dossiers.push({ id: x.id, nom: x.nom }); });
    idx.fichiers.forEach(function (f) { if (permis_(f.min, a)) { if (f.dossier === id) fichiers.push(sortie_(f)); } });
    dossiers.forEach(function (x) { x.n = compte_(idx, x.id, a); });
    dossiers.sort(function (p, q) { return p.nom.localeCompare(q.nom, 'fr'); });
    fichiers.sort(function (p, q) { return p.nom.localeCompare(q.nom, 'fr'); });
    return { ok: true, chemin: chemin, dossiers: dossiers, fichiers: fichiers, total: idx.fichiers.length };
  },
  chercher: function (r, a) {
    var q = norm_(r.requete); if (q.length < 2) fail_('Saisissez au moins deux caractères.');
    var idx = index_(), mots = q.split(' ').filter(function (m) { return m.length > 1; }), vus = {}, out = [];
    var parId = {}; idx.fichiers.forEach(function (f) { parId[f.id] = f; });
    idx.fichiers.forEach(function (f) {
      if (!permis_(f.min, a)) return;
      var cible = norm_(f.nom + ' ' + chemin_(idx, f.dossier));
      var ok = mots.every(function (m) { return cible.indexOf(m) >= 0; });
      if (ok) { vus[f.id] = 1; out.push(sortie_(f, chemin_(idx, f.dossier), 'titre')); }
    });
    try {   // contenu : recherche plein texte de Drive (PDF compris), limitée aux fichiers de la bibliothèque
      var it = DriveApp.searchFiles("fullText contains '" + String(r.requete).replace(/['\\]/g, ' ').slice(0, 80) + "' and trashed = false"), n = 0;
      while (it.hasNext() && n < 200 && out.length < 40) { n++; var f2 = parId[it.next().getId()]; if (f2 && !vus[f2.id] && permis_(f2.min, a)) { vus[f2.id] = 1; out.push(sortie_(f2, chemin_(idx, f2.dossier), 'contenu')); } }
    } catch (e) { /* recherche plein texte indisponible : les titres suffisent */ }
    return { ok: true, documents: out.slice(0, 40) };
  },
  // Lecture pour l'IA : texte des documents Google et fichiers texte ; PDF en entier (petit).
  lire: function (r, a) {
    var f = fichier_(r.id, a), t = f.type;
    var file = DriveApp.getFileById(f.id), mime = file.getMimeType();
    if (mime === 'application/pdf') { if (file.getSize() > MAX_OCTETS) fail_('PDF trop volumineux pour être lu (8 Mo au plus).'); return { ok: true, titre: f.nom, pdf: Utilities.base64Encode(file.getBlob().getBytes()) }; }
    if (mime === 'application/vnd.google-apps.document') return { ok: true, titre: f.nom, texte: DocumentApp.openById(f.id).getBody().getText().slice(0, 60000) };
    if (mime === 'application/vnd.google-apps.spreadsheet') { var feuille = SpreadsheetApp.openById(f.id).getSheets()[0]; return { ok: true, titre: f.nom, texte: feuille.getDataRange().getDisplayValues().slice(0, 500).map(function (l) { return l.join('\t'); }).join('\n') }; }
    if (/^text\//.test(mime) || /json|xml|csv/.test(mime)) return { ok: true, titre: f.nom, texte: file.getBlob().getDataAsString('UTF-8').slice(0, 60000) };
    fail_('Ce type de fichier ne peut pas être lu comme texte (' + t + ').');
  },
  // Téléchargement / aperçu pour le site : contenu en base64 (8 Mo au plus).
  telecharger: function (r, a) {
    var f = fichier_(r.id, a), file = DriveApp.getFileById(f.id), mime = file.getMimeType(), nom = f.nom;
    if (/^application\/vnd\.google-apps\./.test(mime)) {   // documents Google : export PDF
      var blob = file.getAs('application/pdf'); if (blob.getBytes().length > MAX_OCTETS) fail_('Document trop volumineux (8 Mo au plus).');
      return { ok: true, nom: nom.replace(/\.pdf$/i, '') + '.pdf', mime: 'application/pdf', base64: Utilities.base64Encode(blob.getBytes()) };
    }
    if (file.getSize() > MAX_OCTETS) fail_('Fichier trop volumineux pour le téléchargement direct (8 Mo au plus).');
    return { ok: true, nom: nom, mime: mime, base64: Utilities.base64Encode(file.getBlob().getBytes()) };
  },
  // Reconstruit l'index tout de suite (administrateur ou clé partagée).
  reindexer: function (r, a) { if (a.role !== 'admin') fail_('Réservé à l\'administrateur.'); CacheService.getScriptCache().removeAll(['bi:n']); var i = index_(true); return { ok: true, fichiers: i.fichiers.length, dossiers: Object.keys(i.dossiers).length }; }
};

// ---------- identité : session ScoutHub, ou clé partagée (ChatGDB) ----------
function acces_(r) {
  var p = PropertiesService.getScriptProperties(), cle = p.getProperty('CLE_PARTAGEE');
  if (cle && r.cle && String(r.cle) === cle) return { email: 'chatgdb', role: ROLES.indexOf(r.role) >= 0 ? r.role : 'membre' };
  if (!r.token) fail_('Connexion requise : ouvrez la bibliothèque depuis ScoutHub.');
  var cache = CacheService.getScriptCache(), k = 'u:' + sha_(String(r.token)), hit = cache.get(k);
  if (hit) return JSON.parse(hit);
  var api = p.getProperty('SCOUTHUB_API'); if (!api) fail_('Serveur non configuré (SCOUTHUB_API).');
  var res = UrlFetchApp.fetch(api, { method: 'post', contentType: 'text/plain;charset=utf-8', muteHttpExceptions: true, payload: JSON.stringify({ action: 'me', token: r.token }) });
  var j; try { j = JSON.parse(res.getContentText()); } catch (e) { fail_('ScoutHub injoignable.'); }
  if (!j.ok) fail_('Session expirée : reconnectez-vous sur ScoutHub.');
  var a = { email: j.user.email, role: ROLES.indexOf(j.user.role) >= 0 ? j.user.role : 'membre' };
  cache.put(k, JSON.stringify(a), 300);
  return a;
}
function permis_(min, a) { return ROLES.indexOf(a.role) >= ROLES.indexOf(min || 'membre'); }

// ---------- index de l'arborescence Drive (gardé 10 minutes) ----------
function index_(force) {
  var cache = CacheService.getScriptCache();
  if (!force) { var n = Number(cache.get('bi:n') || 0); if (n) { var s = ''; for (var i = 0; i < n; i++) { var part = cache.get('bi:' + i); if (part === null) { s = null; break; } s += part; } if (s) return JSON.parse(s); } }
  var racineId = PropertiesService.getScriptProperties().getProperty('BIBLIO_DOSSIER');
  if (!racineId) fail_('Dossier de la bibliothèque non configuré (BIBLIO_DOSSIER).');
  var racine = DriveApp.getFolderById(racineId), idx = { racine: racineId, dossiers: {}, fichiers: [] }, debut = Date.now();
  idx.dossiers[racineId] = { id: racineId, nom: racine.getName(), parent: '', min: roleDossier_(racine, 'membre') };
  (function parcourir(dossier, id, min) {
    var fs = dossier.getFiles();
    while (fs.hasNext() && idx.fichiers.length < MAX_FICHIERS && Date.now() - debut < 45000) {
      var f = fs.next();
      idx.fichiers.push({ id: f.getId(), nom: f.getName(), dossier: id, type: genre_(f.getMimeType()), taille: f.getSize(), maj: f.getLastUpdated().getTime(), min: min });
    }
    var ds = dossier.getFolders();
    while (ds.hasNext() && Date.now() - debut < 45000) {
      var d = ds.next(), nom = d.getName(); if (nom.charAt(0) === '_') continue;
      var m = roleDossier_(d, min); idx.dossiers[d.getId()] = { id: d.getId(), nom: nom, parent: id, min: m };
      parcourir(d, d.getId(), m);
    }
  })(racine, racineId, idx.dossiers[racineId].min);
  var txt = JSON.stringify(idx), n2 = Math.ceil(txt.length / 90000);
  if (n2 <= 20) { for (var j = 0; j < n2; j++) cache.put('bi:' + j, txt.slice(j * 90000, (j + 1) * 90000), DUREE_INDEX); cache.put('bi:n', String(n2), DUREE_INDEX); }
  return idx;
}
// Rôle minimal d'un dossier : ligne « acces: … » de sa description, jamais moins strict que celui du dossier parent.
function roleDossier_(d, parent) {
  var m = /^\s*acces\s*:\s*([a-z_]+)\s*$/im.exec(d.getDescription() || ''), r = m && ROLES.indexOf(m[1]) >= 0 ? m[1] : 'membre';
  return ROLES.indexOf(r) > ROLES.indexOf(parent) ? r : parent;
}
function genre_(mime) {
  if (mime === 'application/pdf') return 'pdf';
  if (/^image\//.test(mime)) return 'image';
  if (/document|word|opendocument\.text|rtf/.test(mime)) return 'document';
  if (/spreadsheet|excel|csv/.test(mime)) return 'tableur';
  if (/presentation|powerpoint/.test(mime)) return 'diaporama';
  if (/^video\//.test(mime)) return 'video';
  if (/^audio\//.test(mime)) return 'audio';
  if (/^text\//.test(mime)) return 'texte';
  return 'fichier';
}
function fichier_(id, a) {
  var f = index_().fichiers.filter(function (x) { return x.id === String(id || ''); })[0];
  if (!f || !permis_(f.min, a)) fail_('Document introuvable.');
  return f;
}
function sortie_(f, dossier, trouve) { return { id: f.id, nom: f.nom, type: f.type, taille: f.taille, maj: f.maj, dossier: dossier || '', trouve: trouve || '' }; }
function chemin_(idx, id) { var out = [], c = idx.dossiers[id]; while (c && c.parent) { out.unshift(c.nom); c = idx.dossiers[c.parent]; } return out.join(' / '); }
function compte_(idx, id, a) {
  var n = 0, enfants = {}; enfants[id] = 1;
  var change = true; while (change) { change = false; Object.keys(idx.dossiers).forEach(function (k) { var d = idx.dossiers[k]; if (!enfants[k] && enfants[d.parent]) { enfants[k] = 1; change = true; } }); }
  idx.fichiers.forEach(function (f) { if (enfants[f.dossier] && permis_(f.min, a)) n++; });
  return n;
}
function norm_(t) { return String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
function sha_(s) { return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8).map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('').slice(0, 24); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function fail_(msg) { var e = new Error(msg); e.userMessage = msg; throw e; }

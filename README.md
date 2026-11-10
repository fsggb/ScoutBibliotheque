# ScoutBibliotheque

Bibliothèque de documents de la fédération FSGGB : l'arborescence d'un dossier Google Drive devient des rubriques que l'on parcourt, que l'on cherche (titres et contenu des PDF) et que l'on lit dans la page. ChatGDB peut aussi chercher et lire ces documents pour répondre aux questions.

- **Site** (ce dépôt, statique) : publié dans ScoutHub, à l'adresse `https://fsggb.github.io/ScoutHub/ScoutBibliotheque/` (miroir mis à jour automatiquement à chaque changement du dépôt).
- **Serveur** : `backend/Code.gs`, un projet Google Apps Script séparé, déployé en application Web, exécuté « en tant que moi » (le compte qui déploie doit pouvoir lire le dossier). Il vérifie les sessions auprès de ScoutHub.

## Mise en service
1. Créer un projet Apps Script, y coller `backend/Code.gs`.
2. Propriétés du script : `BIBLIO_DOSSIER` (identifiant du dossier Drive racine), `SCOUTHUB_API` (adresse `/exec` du serveur ScoutHub), `CLE_PARTAGEE` (facultatif, un mot de passe long : le même que `BIBLIO_CLE` côté ScoutHub, pour que ChatGDB puisse lire les documents).
3. Déployer > Nouveau déploiement > Application Web (exécuter en tant que « Moi », accès « Tout le monde ») ; autoriser l'accès au Drive.
4. Copier l'adresse `/exec` dans `config.js` (`BIBLIO_API`), commiter : ScoutHub republie dans les minutes qui suivent.
5. Côté ScoutHub (propriétés du script) : `BIBLIO_API` (la même adresse) et `BIBLIO_CLE` (la clé partagée).

## Accès par rubrique
Dans la description d'un dossier Drive, une ligne `acces: chef_unite` (membre, parent, chef_unite, chef_groupe, admin) réserve le dossier et son contenu à ce rôle et aux rôles supérieurs. Un dossier dont le nom commence par `_` est ignoré. L'index est gardé 10 minutes.

# CalqueLa

Essayez un tatouage avant de passer sous l'aiguille. CalqueLa est une application web qui crée un avatar 3D à votre morphologie, puis y applique des motifs importés depuis le dessin d'un artiste.

## Fonctionnalités

- **Avatar 3D réaliste** : homme ou femme, avec des curseurs pour la taille, la corpulence, la musculature, les proportions et la poitrine. On peut aussi choisir le teint et la couleur des sous-vêtements.
- **Cheveux** : 8 coupes (rasé, court, carré, longs, queue de cheval, chignon, bouclés), générées mèche par mèche. Couleur, longueur et frange sont réglables.
- **Poses** : bras, coudes, jambes, genoux, tête et buste, avec des poses rapides (bras levés, biceps, marche…).
- **Import de motifs** : le fond (papier, éclairage inégal) est retiré automatiquement. On garde toutes les couleurs ou seulement le trait noir, les petites taches sont nettoyées, puis on retouche à la gomme.
- **Pose sur la peau** : le motif est peint dans la texture de la peau.
  - Il suit le corps quand on change la morphologie ou la pose.
  - Il se pose à plat (dos, torse) ou enroulé autour d'un membre (bracelet, manchette), sans limite de taille.
- **Édition directe** :
  - glisser pour déplacer, molette pour la taille, Maj + molette pour la rotation, deux doigts sur écran tactile ;
  - calques, opacité, miroir, duplication ;
  - annuler/rétablir.
- **Projet** :
  - sauvegarde automatique dans le navigateur ;
  - enregistrement et ouverture d'un fichier `.calquela.json` ;
  - partage par lien ;
  - export PNG de la vue ou d'une planche quatre vues pour le tatoueur.

## Lancer le projet

Prérequis : **Java 21**. Node.js 20+ n'est nécessaire que pour modifier le frontend.

```bash
cd backend
./gradlew bootRun        # Windows : gradlew.bat bootRun
```

Ouvrez ensuite http://localhost:8080. Le site déjà construit se trouve dans `backend/src/main/resources/static` : un seul programme suffit.

### Développer le frontend

```bash
# terminal 1
cd backend && ./gradlew bootRun
# terminal 2
cd frontend && npm install && npm run dev     # http://localhost:5173
```

`npm run build` reconstruit le site directement dans le dossier `static` du backend.

### Tests

```bash
cd backend && ./gradlew test
```

## Architecture

```
calquela/
├── backend/                Spring Boot 3.5 (Java 21)
│   └── fr/calquela/
│       ├── tattoo/         TattooProcessor (Java pur) + API /api/tattoos/process
│       ├── project/        partage de projets : fichiers JSON, pas de base de données
│       ├── config/         en-têtes de sécurité, limitation de débit, propriétés
│       └── web/            gestion des erreurs (messages en français)
├── frontend/               Vite + Three.js, JavaScript natif
│   └── src/
│       ├── avatar/         morphologie, squelette, matériau de peau, poses
│       ├── hair/           cheveux procéduraux
│       ├── tattoo/         cuisson UV, manipulation, détourage de secours
│       ├── state/          historique, format de projet, partage
│       ├── ui/             panneaux, import, composants
│       └── export/         images PNG
└── tools/build_avatar.py   conversion des données MakeHuman en avatar.bin
```

### Points techniques

- **Avatar paramétrique** : le navigateur combine les mêmes cibles que MakeHuman (36 morphs compressés, 4,7 Mo, environ 3,8 Mo transmis grâce à la compression). Ensuite :
  - les articulations du squelette sont recalculées à partir de la nouvelle forme ;
  - les yeux sont réajustés.
- **Tatouages cuits dans l'espace UV** : chaque triangle du corps est dessiné à sa place dans une texture de 4096 px.
  - Chaque pixel est projeté dans le repère du motif, plan ou cylindre autour du membre, sur le corps *neutre*. Le tatouage suit donc la morphologie et la pose sans calcul supplémentaire.
  - Une passe de dilatation comble les coutures entre les zones de la texture.
- **Détourage** :
  - le fond est modélisé par une surface polynomiale ajustée sur les pixels qui ressemblent au papier, ce qui compense un éclairage inégal sans être trompé par de grands aplats ;
  - chaque pixel est normalisé par ce fond, puis la couleur de l'encre est démélangée ;
  - les petites taches sont supprimées par composantes connexes.
  - Si le serveur ne répond pas, un portage JavaScript du même algorithme prend le relais : le site fonctionne aussi en hébergement statique, sauf le partage par lien.
- **Sécurité** :
  - API : CSP stricte, limite de requêtes POST par IP, contrôle des dimensions d'image avant décodage (protection contre les bombes de décompression) ;
  - partage : identifiants aléatoires non devinables, validation des chemins, JSON revalidé avant stockage, projets supprimés après 30 jours.

Réglages dans `backend/src/main/resources/application.properties` (préfixe `calquela.`).

## Données et licences

- Corps, morphologies, squelette et yeux : données de [MakeHuman](https://www.makehumancommunity.org), publiées en **CC0**. Seules ces données sont utilisées, pas le code de MakeHuman (AGPL). Pour les régénérer :
  ```bash
  git clone --depth 1 https://github.com/makehumancommunity/makehuman
  python3 tools/build_avatar.py --mh makehuman/makehuman/data
  ```
- [Three.js](https://threejs.org) et [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) : licence MIT.
- Les motifs importés restent la propriété de leurs auteurs. Demandez l'accord de l'artiste avant de partager un projet qui contient son dessin.

## Pistes

- Version Unity (bureau, mobile) qui réutilise le même format de projet.
- Piercings, rendu « encre cicatrisée ».
- Passage à Spring Boot 4.

<!-- GROGNON -->

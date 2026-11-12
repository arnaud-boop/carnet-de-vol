# carnet-de-vol

Carnet de vol personnel (SkyLog). Page statique publiee avec GitHub Pages.

Ce depot ne contient aucune donnee de vol. Les vols et les photos sont dans un
depot GitHub prive. La page les lit et les modifie avec une cle d'acces
(fine-grained personal access token) collee une fois sur chaque appareil.

- `index.html` : structure et mise en page
- `app.js` : logique de la page et lien avec GitHub
- `airports.js` : liste integree de 184 aeroports

## Publier une mise a jour

Changer le numero de version a deux endroits, avec la meme valeur :
la balise `<meta name="app-version">` dans `index.html` et le fichier `version.txt`.
Les navigateurs chargent alors les nouveaux fichiers tout de suite,
au lieu de garder l'ancienne version jusqu'a 10 minutes.

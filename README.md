# carnet-de-vol

Carnet de vol personnel (SkyLog). Page statique publiee avec GitHub Pages.

Ce depot ne contient aucune donnee de vol. Les vols et les photos sont dans un
depot GitHub prive. La page les lit et les modifie avec une cle d'acces
(fine-grained personal access token) collee une fois sur chaque appareil.

Deux carnets dans le meme depot de donnees, avec la meme cle :

- `flights.json` : carnet de Liv
- `arnaud.json` : carnet d'Arnaud. En plus des vols detailles, il contient
  l'historique importe de son fichier Excel (`routes` : trajets avec un nombre
  de vols, sans dates, jusqu'a `historyUntil`). Pour chaque trajet, `ab` donne
  le nombre de vols dans le sens `from` vers `to` (`abEst` : repartition estimee).
  `airportAirlines` donne les compagnies prises dans chaque aeroport. `airline`
  donne la compagnie d'un trajet quand elle se deduit de ces listes
  (`airlineEst` : seulement probable).

Le bouton Liv / Arnaud en haut de la page change de carnet. Chaque appareil
retient le dernier carnet ouvert. Les adresses `#liv` et `#arnaud` ouvrent
directement un carnet.

- `index.html` : structure et mise en page
- `app.js` : logique de la page et lien avec GitHub
- `airports.js` : liste integree de 184 aeroports

## Publier une mise a jour

Changer le numero de version a deux endroits, avec la meme valeur :
la balise `<meta name="app-version">` dans `index.html` et le fichier `version.txt`.
Les navigateurs chargent alors les nouveaux fichiers tout de suite,
au lieu de garder l'ancienne version jusqu'a 10 minutes.

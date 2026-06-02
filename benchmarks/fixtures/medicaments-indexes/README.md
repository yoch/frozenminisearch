# Index FrozenMiniSearch (BDPM / vétérinaire)

Copie locale des snapshots MSv5 exportés depuis [fr.gouv.medicaments.rest](https://github.com/yoch/fr.gouv.medicaments.rest) (`data/search-indexes`).

| Fichier | termCount (manifest) | Intérêt bench |
|---------|---------------------|---------------|
| `bdpm_presentations.msbin` | 37 275 | Plus grand vocabulaire — fuzzy à grande échelle |
| `bdpm_specialites.msbin` | 23 015 | Noms de spécialités (français, tirets, chiffres) |
| `bdpm_compositions.msbin` | 20 796 | Libellés composition / substances |
| `bdpm_mitm.msbin` | 11 703 | Médicaments d’intérêt thérapeutique majeur |
| `bdpm_substances.msbin` | 3 815 | Substances actives (termes moyens) |
| `bdpm_generiques.msbin` | 1 999 | Peu de termes, beaucoup de documents |
| `vet_medicaments.msbin` | 5 852 | Domaine vétérinaire |

Non copiés (peu utiles pour le radix fuzzy) : `ruptures` (11 termes), `conditions` (346 termes), avis SMR/ASMR.

Mettre à jour : recopier depuis la source puis `yarn benchmark:packed-fuzzy`.

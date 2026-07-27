# Intégration Philips Hue pour Gladys Assistant

Pilotez vos lampes Philips Hue depuis Gladys, directement sur votre réseau local
(aucun compte cloud Hue nécessaire).

## Ce que vous obtenez

Chaque lampe Hue est exposée comme un appareil Gladys avec les fonctionnalités
qu'elle prend en charge :

| Type de lampe Hue       | Marche/Arrêt | Luminosité | Couleur | Température de blanc |
| ----------------------- | :----------: | :--------: | :-----: | :------------------: |
| On/Off light            |      ✅      |            |         |                      |
| Dimmable light          |      ✅      |     ✅     |         |                      |
| Color temperature light |      ✅      |     ✅     |         |          ✅          |
| Color light             |      ✅      |     ✅     |   ✅    |                      |
| Extended color light    |      ✅      |     ✅     |   ✅    |          ✅          |

Les états sont rafraîchis par interrogation à l'intervalle choisi (60 s par défaut).

## Configuration

1. Vérifiez que votre bridge Hue est allumé et connecté au même réseau local que
   votre serveur Gladys.
2. Ouvrez l'écran **Configuration** de l'intégration et cliquez sur
   **Découvrir les bridges**. L'adresse IP de votre bridge doit apparaître. Si la
   découverte automatique échoue, saisissez l'IP du bridge dans le champ
   **Adresse IP du bridge**.
3. **Appuyez sur le bouton rond** situé sur le dessus du bridge Hue.
4. Dans les 30 secondes, cliquez sur **Appairer le bridge**. En cas de succès,
   vos lampes apparaissent dans l'onglet **Découverte**, prêtes à être créées.

## Remarques

- Les identifiants d'appairage (le _username_ du bridge) sont stockés dans le
  volume de données de l'intégration (`/data`) et survivent aux redémarrages.
  L'appairage n'est fait qu'une seule fois.
- Cette intégration utilise uniquement l'API locale Hue ; elle ne communique
  jamais avec le cloud Hue.
- Le conteneur doit pouvoir joindre le bridge sur votre réseau local (HTTP,
  port 80).

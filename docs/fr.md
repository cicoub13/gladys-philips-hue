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

Les états sont rafraîchis par interrogation à l'intervalle choisi dans
**Intervalle de rafraîchissement** (toutes les minutes par défaut).

## Configuration

1. Vérifiez que votre bridge Hue est allumé et connecté au même réseau local que
   votre serveur Gladys.
2. Ouvrez l'écran **Configuration** de l'intégration et cliquez sur
   **Découvrir les bridges**. L'adresse IP de votre bridge doit apparaître. Si la
   découverte automatique échoue, saisissez l'IP du bridge dans le champ
   **Adresse IP du bridge** (une adresse ou un nom d'hôte simple, par exemple
   `192.168.1.42` — toute autre saisie est ignorée et le bouton vous le signale).
3. **Appuyez sur le bouton rond** situé sur le dessus du bridge Hue.
4. Dans les 30 secondes, cliquez sur **Appairer le bridge**. En cas de succès,
   vos lampes apparaissent dans l'onglet **Découverte**, prêtes à être créées.

## Comment le bridge est trouvé

Trois méthodes sont tentées, dans cet ordre, et la première qui trouve un bridge
l'emporte :

1. **SSDP** sur votre réseau local, effectué par Gladys pour le compte de
   l'intégration ;
2. **mDNS** (`_hue._tcp`), par le même mécanisme ;
3. le service **N-UPnP** de Philips (`discovery.meethue.com`) en dernier recours.
   Celui-ci est un service _cloud_ Philips : il nécessite un accès Internet et ne
   renvoie que les bridges vus depuis la même adresse IP publique. Il n'est
   sollicité que si les deux méthodes locales ne trouvent rien.

## Remarques

- Les identifiants d'appairage (le _username_ du bridge) sont stockés dans le
  volume de données de l'intégration (`/data`) et survivent aux redémarrages.
  L'appairage n'est fait qu'une seule fois.
- Le pilotage de vos lampes est toujours **100 % local** : les commandes et les
  lectures d'état vont directement au bridge sur votre réseau. Seule l'étape de
  découverte de dernier recours ci-dessus peut contacter un serveur Philips, et
  uniquement pendant que vous cherchez votre bridge.
- Le conteneur doit pouvoir joindre le bridge sur votre réseau local (HTTP,
  port 80).

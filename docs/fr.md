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

Quelle que soit la méthode, chaque appareil trouvé est **vérifié** avant de vous
être proposé : l'intégration lui demande sa fiche d'identité Hue (`/api/config`).
Les appareils qui ne répondent pas comme un bridge Philips Hue — imprimante,
NAS, enceinte… — sont écartés, et le message vous indique combien l'ont été.

## Dépannage

**« Aucun bridge Hue trouvé »**, alors que le bridge est allumé : vérifiez qu'il
est bien sur le même réseau que Gladys (un réseau invité ou un VLAN séparé le
rend invisible). Si le message précise que d'autres appareils ont répondu mais
qu'aucun n'est un bridge Hue, c'est que la découverte a vu votre réseau mais pas
le bridge : saisissez son adresse IP dans **Adresse IP du bridge**. Vous la
trouverez dans l'application Hue, dans **Paramètres → Mes appareils → Bridge**.

**« Le bouton n'a pas été pressé »** : le bridge a bien été trouvé, seul
l'appairage manque. Appuyez sur le bouton rond du bridge, puis recliquez sur
**Appairer le bridge** dans les 30 secondes qui suivent.

**Les lampes ne répondent plus** : vérifiez que le bridge n'a pas changé
d'adresse IP (fixez-la dans votre box), puis relancez une découverte.

## Remarques

- Les identifiants d'appairage (le _username_ du bridge) sont stockés dans le
  volume de données de l'intégration (`/data`) et survivent aux redémarrages.
  L'appairage n'est fait qu'une seule fois.
- Le pilotage de vos lampes est toujours **100 % local** : les commandes et les
  lectures d'état vont directement au bridge sur votre réseau. Seule l'étape de
  découverte de dernier recours ci-dessus peut contacter un serveur Philips, et
  uniquement pendant que vous cherchez votre bridge.
- Le conteneur doit pouvoir joindre le bridge sur votre réseau local (HTTP sur le
  port 80, ou HTTPS si votre bridge n'accepte plus le HTTP simple).
- **Sécurité du HTTPS** : un bridge Hue présente un certificat émis par Philips
  et non par une autorité publique. Lors du premier contact, l'intégration
  vérifie que ce certificat porte bien l'identifiant du bridge, puis en mémorise
  l'empreinte. Aux connexions suivantes, toute empreinte différente est refusée :
  un appareil qui se ferait passer pour votre bridge est ainsi bloqué.

# Intégration Philips Hue pour Gladys Assistant

## Présentation

Pilotez vos lampes Philips Hue depuis Gladys, directement sur votre réseau local
(aucun compte cloud Hue nécessaire).

### Ce que vous obtenez

Chaque lampe Hue est exposée comme un appareil Gladys avec les fonctionnalités
qu'elle prend en charge :

| Type de lampe Hue       | Marche/Arrêt | Luminosité | Couleur | Température de blanc |
| ----------------------- | :----------: | :--------: | :-----: | :------------------: |
| On/Off light            |      ✅      |            |         |                      |
| Dimmable light          |      ✅      |     ✅     |         |                      |
| Color temperature light |      ✅      |     ✅     |         |          ✅          |
| Color light             |      ✅      |     ✅     |   ✅    |                      |
| Extended color light    |      ✅      |     ✅     |   ✅    |          ✅          |

L'intégration interroge votre bridge à l'intervalle choisi dans **Intervalle de
rafraîchissement** (toutes les minutes par défaut) : les changements faits hors
de Gladys — application Hue, interrupteur mural, variateur, automatisations Hue
— apparaissent dans Gladys dans cet intervalle. Ceux faits depuis Gladys
apparaissent immédiatement.

Une lampe coupée à l'interrupteur mural apparaît éteinte dans Gladys, avec un
badge **injoignable** sur la page Appareils, jusqu'à ce qu'elle soit de nouveau
alimentée.

### Scènes Hue dans les scènes Gladys

> **Nécessite Gladys 5.1 ou supérieur.**

L'action **Activer une scène Hue** de l'éditeur de scènes Gladys rappelle une
scène créée dans l'application Hue : toutes ses lampes prennent leur couleur et
leur luminosité d'un coup, avec la transition du bridge.

- **Scène** : le nom affiché dans l'application Hue, par exemple `Détente`. Les
  majuscules et les espaces autour sont ignorés.
- **Pièce ou zone** (optionnel) : à renseigner seulement si plusieurs pièces ont
  une scène du même nom, par exemple `Salon`.

Si le nom ne correspond à aucune scène, ou à plusieurs, l'action échoue et les
logs de la scène indiquent les scènes (ou les pièces) disponibles. Le reste de
la scène Gladys continue de s'exécuter.

## Prérequis

- **Gladys 5.1 ou supérieur.**
- Un bridge Philips Hue, auquel vos lampes sont déjà associées.
- Un accès physique au bridge : l'appairage vous demande d'appuyer sur son
  bouton rond.
- Aucun compte cloud Hue n'est nécessaire.
- Le conteneur doit pouvoir joindre le bridge sur votre réseau local (HTTP sur le
  port 80, ou HTTPS si votre bridge n'accepte plus le HTTP simple).

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

### Remplacer un bridge

Après avoir remplacé votre bridge ou migré vers un Hue Bridge Pro, cliquez sur
**Appairer le bridge**. Après une migration, le nouveau bridge accepte en
général déjà l'intégration : essayez d'abord sans appuyer sur son bouton, et si
le message le demande, appuyez sur le bouton puis recliquez.

L'intégration reconnaît le nouveau bridge comme le remplaçant de l'ancien quand
l'ancien ne répond plus (ou a été oublié) et que le nouveau accepte son accès,
ou porte au moins la moitié de ses lampes créées dans Gladys. Il prend alors la
place de l'ancien : les lampes déjà créées continuent de fonctionner, avec leurs
pièces, scènes et historique, et le message indique quel bridge il remplace.

Sinon, les lampes du nouveau bridge apparaissent comme de nouveaux appareils
dans l'onglet **Découverte**. Cliquez sur **Oublier les bridges injoignables** :
l'intégration oublie tous les bridges appairés qui ne répondent plus, ou
n'acceptent plus l'intégration, et cesse de les signaler injoignables. Un bridge
qui fonctionne n'est jamais oublié, même s'il est occupé, pas plus qu'un bridge
qui vient tout juste de cesser de répondre (il redémarre peut-être) : recliquez
quand il ne répond plus depuis 5 minutes. Supprimez ensuite les anciens
appareils depuis la page Appareils.

## Comment le bridge est trouvé

1. **mDNS** (`_hue._tcp`) sur votre réseau local, effectué par Gladys pour le
   compte de l'intégration : la méthode recommandée par Philips, et la seule à
   laquelle répond un Hue Bridge Pro ;
2. **SSDP**, par le même mécanisme, pour les bridges dont le mDNS n'atteint pas
   Gladys. Les bridges trouvés par les deux méthodes sont réunis : plusieurs
   bridges (un bridge carré et un Bridge Pro, par exemple) sont tous trouvés ;
3. le service **N-UPnP** de Philips (`discovery.meethue.com`) en dernier recours.
   Celui-ci est un service _cloud_ Philips : il nécessite un accès Internet et ne
   renvoie que les bridges vus depuis la même adresse IP publique. Il n'est
   sollicité que si les deux méthodes locales ne trouvent rien.

Quelle que soit la méthode, chaque appareil trouvé est **vérifié** avant de vous
être proposé : l'intégration lui demande sa fiche d'identité Hue (`/api/config`).
Les appareils qui ne répondent pas comme un bridge Philips Hue — imprimante,
NAS, enceinte… — sont écartés, et le message vous indique combien l'ont été.

## Remarques

- Les identifiants d'appairage (le _username_ du bridge) sont stockés dans le
  volume de données de l'intégration (`/data`) et survivent aux redémarrages.
  L'appairage n'est fait qu'une seule fois.
- Le pilotage de vos lampes est toujours **100 % local** : les commandes et les
  lectures d'état vont directement au bridge sur votre réseau. Seule l'étape de
  découverte de dernier recours ci-dessus peut contacter un serveur Philips, et
  uniquement pendant que vous cherchez votre bridge.
- **Sécurité du HTTPS** : un bridge Hue présente un certificat émis par Philips
  et non par une autorité publique. Lors du premier contact, l'intégration
  vérifie que ce certificat porte bien l'identifiant du bridge, puis en mémorise
  l'empreinte. Aux connexions suivantes, toute empreinte différente est refusée :
  un appareil qui se ferait passer pour votre bridge est ainsi bloqué.

## Dépannage

Les logs de l'intégration sont accessibles dans Gladys, depuis l'onglet
**Configuration** de l'intégration, avec les commandes de supervision (démarrer,
arrêter, redémarrer…).

**« Aucun bridge Hue trouvé »**, alors que le bridge est allumé : vérifiez qu'il
est bien sur le même réseau que Gladys (un réseau invité ou un VLAN séparé le
rend invisible). Si le message précise que d'autres appareils ont répondu mais
qu'aucun n'est un bridge Hue, c'est que la découverte a vu votre réseau mais pas
le bridge : saisissez son adresse IP dans **Adresse IP du bridge**. Vous la
trouverez dans l'application Hue, dans **Paramètres → Mes appareils → Bridge**.

**« Le bouton n'a pas été pressé »** : le bridge a bien été trouvé, seul
l'appairage manque. Appuyez sur le bouton rond du bridge, puis recliquez sur
**Appairer le bridge** dans les 30 secondes qui suivent.

**Les lampes ne répondent plus** : le bridge a peut-être changé d'adresse IP.
L'intégration le cherche sur votre réseau local en arrière-plan, et le suit à sa
nouvelle adresse sans nouvel appairage ; **Découvrir les bridges** fait de même
tout de suite. Si les lampes ne reviennent toujours pas, appuyez sur le bouton
du bridge, puis recliquez sur **Appairer le bridge**. Vos lampes gardent leurs
appareils dans Gladys. Fixez tout de même l'adresse du bridge dans votre box
pour qu'elle ne change plus. Une exception : un bridge appairé avec la version
1.1.0 ou antérieure via **Adresse IP du bridge**, que l'intégration n'a pas
joint depuis sa mise à jour, n'est pas suivi et revient avec de nouveaux
appareils.

**Les lampes ne répondent plus après une mise à jour du bridge** : depuis le
firmware 1.78, le bridge refuse le HTTP simple. Un bridge appairé en HTTP passe
automatiquement en HTTPS, sans nouvel appairage, et les logs indiquent
`Bridge … blocks plain HTTP, switched to HTTPS`. Si les logs indiquent plutôt
`HTTPS failed too`, appuyez sur le bouton du bridge et recliquez sur
**Appairer le bridge** : vos lampes gardent leurs appareils dans Gladys.

**« Bridge Hue injoignable. Vérifiez qu'il est allumé et sur le même réseau que
Gladys. »** dans l'état de connexion : le bridge appairé ne répond plus. Tant
qu'il est absent, une commande peut échouer avec
`Hue bridge unreachable: light … will be available again as soon as the bridge answers`.
L'intégration continue d'essayer en arrière-plan, et les lampes reviennent
d'elles-mêmes dès que le bridge répond. Si ce bridge a disparu pour de bon
(remplacé, migré vers un Hue Bridge Pro), cliquez sur **Oublier les bridges
injoignables** (voir « Remplacer un bridge »). Un bridge réinitialisé n'a besoin
que d'être appairé à nouveau.

**« Un bridge Hue a été trouvé mais n'a pas pu être appairé »** : le bridge a
répondu à la découverte, puis a échoué pendant l'appairage. Vérifiez qu'il reste
joignable depuis Gladys, puis recliquez sur **Appairer le bridge**. Les logs de
l'intégration en donnent la raison (`Pairing with … failed: …`).

**« … mais les identifiants n'ont PAS pu être enregistrés »** : l'appairage a
réussi, mais l'intégration n'a pas pu écrire dans son volume de données
(`/data`). Vos lampes fonctionnent jusqu'au prochain redémarrage, après quoi il
faudra appairer à nouveau. Vérifiez que le volume de données de l'intégration
est accessible en écriture.

**`Bridge … is no longer paired, pair it again from the Configuration screen`**
quand vous pilotez une lampe, ou **« Aucun bridge Hue appairé »** : relancez
**Découvrir les bridges** puis **Appairer le bridge** (voir « Configuration »).

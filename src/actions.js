// -----------------------------------------------------------------------------
// Manifest action handlers (buttons of the Configuration screen).
//
// The external SDK has no custom front-end controllers: user-triggered flows are
// exposed as `actions` in `gladys-assistant-integration.json`. Each handler
// returns a multi-language message displayed under its button (a thrown error is
// displayed too).
//
// These replace what a classic in-tree Gladys service would do with REST
// controllers (discover bridges / press-the-button pairing).
// -----------------------------------------------------------------------------

/**
 * Warn the user that the address they typed was ignored, or nothing at all.
 * @param {import('./manager.js').HueManager} manager - The Hue manager.
 * @returns {{ en: string, fr: string } | undefined} Message about the rejected input.
 */
function rejectedIpMessage(manager) {
  const rejected = manager.config.bridge_ip_rejected;
  if (!rejected) {
    return undefined;
  }
  return {
    en: `The address "${rejected}" is not a valid IP address or hostname and was ignored. Example: 192.168.1.42`,
    fr: `L'adresse « ${rejected} » n'est pas une adresse IP ou un nom d'hôte valide et a été ignorée. Exemple : 192.168.1.42`,
  };
}

/**
 * Describe a bridge the way a human recognizes it: its name, its model and its
 * address, rather than a bare IP.
 * @param {{ ip: string, name?: string, model?: string }} bridge - Identified bridge.
 * @returns {string} Human-readable description.
 */
function describeBridge(bridge) {
  const model = bridge.model ? ` (${bridge.model})` : '';
  return `${bridge.name || 'Philips hue'}${model} — ${bridge.ip}`;
}

/**
 * "Discover bridges" button: list the Hue bridges found on the network.
 * @param {import('./manager.js').HueManager} manager - The Hue manager.
 * @returns {Promise<{ en: string, fr: string }>} Message shown under the button.
 */
export async function discoverBridgesAction(manager) {
  const rejected = rejectedIpMessage(manager);
  if (rejected) {
    return rejected;
  }

  const { bridges, ignored } = await manager.identifiedBridges();

  if (bridges.length === 0) {
    // Saying "we saw devices but none was a bridge" is the difference between a
    // user checking their network and a user staring at an empty list.
    const seen =
      ignored.length > 0
        ? {
            en: ` ${ignored.length} other device(s) answered on the network but none is a Hue bridge.`,
            fr: ` ${ignored.length} autre(s) appareil(s) ont répondu sur le réseau mais aucun n'est un bridge Hue.`,
          }
        : { en: '', fr: '' };
    return {
      en: `No Hue bridge found on your network.${seen.en} Check that the bridge is powered on and connected to the same network as Gladys, or enter its IP address manually above.`,
      fr: `Aucun bridge Hue trouvé sur votre réseau.${seen.fr} Vérifiez que le bridge est allumé et connecté au même réseau que Gladys, ou saisissez son adresse IP manuellement ci-dessus.`,
    };
  }

  const listed = bridges.map((bridge) => describeBridge(bridge)).join(', ');
  const ignoredSuffix =
    ignored.length > 0
      ? {
          en: ` (${ignored.length} other device(s) ignored)`,
          fr: ` (${ignored.length} autre(s) appareil(s) ignoré(s))`,
        }
      : { en: '', fr: '' };
  return {
    en: `Found ${bridges.length} bridge(s): ${listed}${ignoredSuffix.en}. Now press the link button on the bridge and click "Pair bridge".`,
    fr: `${bridges.length} bridge(s) trouvé(s) : ${listed}${ignoredSuffix.fr}. Appuyez maintenant sur le bouton du bridge puis cliquez sur « Appairer le bridge ».`,
  };
}

/**
 * "Pair bridge" button: create a user on each candidate bridge (the physical
 * link button must have been pressed), then re-publish the discovered devices.
 * @param {import('./manager.js').HueManager} manager - The Hue manager.
 * @returns {Promise<{ en: string, fr: string }>} Message shown under the button.
 */
export async function pairBridgeAction(manager) {
  const { paired, pending, unreachable, notABridge } = await manager.pairBridges();

  if (paired.length > 0) {
    const names = paired.map((bridge) => describeBridge(bridge)).join(', ');
    // New credentials available: refresh the device list right away.
    await manager.syncDevices();
    if (manager.store.persistError) {
      // The pairing worked, but the credentials could not be written to /data.
      return {
        en: `Paired with: ${names}, and your lights are in the Discovery tab — but the credentials could NOT be saved (${manager.store.persistError.message}). They will be lost when the integration restarts. Check that the integration data volume is writable.`,
        fr: `Appairage réussi avec : ${names}, vos lampes sont dans l'onglet Découverte — mais les identifiants n'ont PAS pu être enregistrés (${manager.store.persistError.message}). Ils seront perdus au redémarrage de l'intégration. Vérifiez que le volume de données de l'intégration est accessible en écriture.`,
      };
    }
    return {
      en: `Paired successfully with: ${names}. Your lights are now available in the Discovery tab.`,
      fr: `Appairage réussi avec : ${names}. Vos lampes sont maintenant disponibles dans l'onglet Découverte.`,
    };
  }

  // The bridge is there and answered: the only thing missing is the button.
  if (pending.length > 0) {
    const names = pending.map((bridge) => describeBridge(bridge)).join(', ');
    return {
      en: `The bridge was found but the link button was not pressed: ${names}. Press the round button on top of the bridge, then click "Pair bridge" within 30 seconds.`,
      fr: `Le bridge a été trouvé mais le bouton n'a pas été pressé : ${names}. Appuyez sur le bouton rond du bridge, puis cliquez sur « Appairer le bridge » dans les 30 secondes.`,
    };
  }

  // A real bridge that stopped answering between identification and pairing.
  if (unreachable.length > 0) {
    const names = unreachable.map((bridge) => describeBridge(bridge)).join(', ');
    return {
      en: `A Hue bridge was found but could not be paired: ${names}. Check that it stays reachable from Gladys, then try again.`,
      fr: `Un bridge Hue a été trouvé mais n'a pas pu être appairé : ${names}. Vérifiez qu'il reste joignable depuis Gladys, puis réessayez.`,
    };
  }

  // Nothing on the network proved to be a bridge. Say so explicitly rather than
  // blaming an address the user may never have typed.
  if (notABridge.length > 0) {
    return {
      en: `No Hue bridge to pair: ${notABridge.length} device(s) answered on the network but none is a Hue bridge. Check that your bridge is powered on and on the same network as Gladys, or enter its IP address manually above.`,
      fr: `Aucun bridge Hue à appairer : ${notABridge.length} appareil(s) ont répondu sur le réseau mais aucun n'est un bridge Hue. Vérifiez que votre bridge est allumé et sur le même réseau que Gladys, ou saisissez son adresse IP manuellement ci-dessus.`,
    };
  }

  return (
    rejectedIpMessage(manager) || {
      en: 'No bridge to pair. Run "Discover bridges" first or set the bridge IP manually.',
      fr: "Aucun bridge à appairer. Lancez d'abord « Découvrir les bridges » ou renseignez l'IP manuellement.",
    }
  );
}

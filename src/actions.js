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

import { discoverBridges } from './hue/discovery.js';

/**
 * "Discover bridges" button: list the Hue bridges found on the network.
 * @param {import('./manager.js').HueManager} manager - The Hue manager.
 * @returns {Promise<{ en: string, fr: string }>} Message shown under the button.
 */
export async function discoverBridgesAction(manager) {
  const bridges = await discoverBridges();
  const manualIp = manager.config.bridge_ip;
  if (bridges.length === 0 && !manualIp) {
    return {
      en: 'No Hue bridge found on your network. You can enter its IP address manually above.',
      fr: 'Aucun bridge Hue trouvé sur votre réseau. Vous pouvez saisir son adresse IP manuellement ci-dessus.',
    };
  }
  const ips = bridges.map((b) => b.ip);
  if (manualIp && !ips.includes(manualIp)) {
    ips.push(`${manualIp} (manual)`);
  }
  return {
    en: `Found ${ips.length} bridge(s): ${ips.join(', ')}. Now press the link button on the bridge and click "Pair bridge".`,
    fr: `${ips.length} bridge(s) trouvé(s) : ${ips.join(', ')}. Appuyez maintenant sur le bouton du bridge puis cliquez sur « Appairer le bridge ».`,
  };
}

/**
 * "Pair bridge" button: create a user on each candidate bridge (the physical
 * link button must have been pressed), then re-publish the discovered devices.
 * @param {import('./manager.js').HueManager} manager - The Hue manager.
 * @param {object} gladys - The GladysIntegration SDK instance.
 * @returns {Promise<{ en: string, fr: string }>} Message shown under the button.
 */
export async function pairBridgeAction(manager, gladys) {
  const { paired, pending, failed } = await manager.pairBridges();

  if (paired.length > 0) {
    // New credentials available: refresh the device list right away.
    await gladys.publishDiscoveredDevices(await manager.buildDiscoveredDevices());
    return {
      en: `Paired successfully with: ${paired.join(', ')}. Your lights are now available in the Discovery tab.`,
      fr: `Appairage réussi avec : ${paired.join(', ')}. Vos lampes sont maintenant disponibles dans l'onglet Découverte.`,
    };
  }

  if (pending.length > 0) {
    return {
      en: `Link button not pressed for: ${pending.join(', ')}. Press the round button on top of the bridge, then click "Pair bridge" within 30 seconds.`,
      fr: `Bouton du bridge non pressé pour : ${pending.join(', ')}. Appuyez sur le bouton rond du bridge, puis cliquez sur « Appairer le bridge » dans les 30 secondes.`,
    };
  }

  if (failed.length > 0) {
    return {
      en: `Could not reach any bridge (${failed.join(', ')}). Check the IP address and that the bridge is on the same network.`,
      fr: `Impossible de joindre un bridge (${failed.join(', ')}). Vérifiez l'adresse IP et que le bridge est sur le même réseau.`,
    };
  }

  return {
    en: 'No bridge to pair. Run "Discover bridges" first or set the bridge IP manually.',
    fr: "Aucun bridge à appairer. Lancez d'abord « Découvrir les bridges » ou renseignez l'IP manuellement.",
  };
}

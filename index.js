// -----------------------------------------------------------------------------
// Entry point of the Philips Hue external integration for Gladys Assistant.
//
// This file only WIRES the SDK to the HueManager (src/manager.js); it holds no
// protocol logic. It:
//   1. instantiates the SDK (connection, auth, reconnection: handled for us);
//   2. loads the persisted bridges;
//   3. registers the event handlers BEFORE connect();
//   4. connects and publishes the discovered lights.
//
// Environment variables provided by the Gladys supervisor:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// `new GladysIntegration()` reads them automatically.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './src/config.js';
import { HueManager } from './src/manager.js';
import { discoverBridgesAction, pairBridgeAction } from './src/actions.js';

const gladys = new GladysIntegration();

// The manager owns bridges, the dispatch registry and the Hue protocol.
// Its config is hot-reloaded via onConfigUpdated / on 'connected'.
const manager = new HueManager(gladys, normalizeConfig());

// --- Discovery: Gladys asks for the list of devices --------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> publishing Hue lights');
  await manager.syncDevices();
});

// --- Command: the user acts on a controllable feature ------------------------
gladys.onSetValue(async (device, feature, value) => {
  await manager.setValue(device, feature, value);
});

// --- Polling: Gladys asks to refresh a light ---------------------------------
gladys.onPoll(async (device) => {
  await manager.poll(device);
});

// --- Manifest actions (Configuration screen buttons) -------------------------
gladys.onAction('discover_bridges', () => {
  logger.info('Action discover_bridges');
  return discoverBridgesAction(manager);
});

gladys.onAction('pair_bridge', () => {
  logger.info('Action pair_bridge');
  return pairBridgeAction(manager);
});

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('onConfigUpdated -> new configuration received');
  manager.setConfig(normalizeConfig(newConfig));
  // Re-publish: the poll frequency (per-device property) may have changed.
  await manager.syncDevices();
});

// --- Connection lifecycle ----------------------------------------------------
gladys.on('connected', async () => {
  try {
    manager.setConfig(normalizeConfig(await gladys.getConfig()));
    await manager.syncDevices();
  } catch (err) {
    logger.error('Post-connection initialization failed', err);
    await gladys
      .setConnectionStatus(false, {
        en: 'Initialization failed, check the integration logs.',
        fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
      })
      .catch(() => {});
  }
});

// --- Graceful shutdown -------------------------------------------------------
gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Philips Hue integration...');
manager
  .init()
  .then(() => gladys.connect())
  .catch((err) => {
    logger.error('Initial connection failed', err);
    process.exit(1);
  });

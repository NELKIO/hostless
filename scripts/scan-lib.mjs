// Helpers for scripts, from the built library.
import { signEvent as sign, checkMqttBroker } from '../dist/index.js';
import { generateSecret } from '../dist/crypto/schnorr.js';
import { toHex, fromHex } from '../dist/util/bytes.js';

export const generateSecretHex = () => toHex(generateSecret());
export const signEvent = (skHex, e) => sign(fromHex(skHex), e);
export { checkMqttBroker };

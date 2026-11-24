/** Side-effect module for script-tag users: registers <hostless-lobby>, <hostless-link>, <hostless-sync>, <hostless-netcheck>. */
import { defineHostlessElements } from './index.js';

defineHostlessElements();

export { defineHostlessElements };

import base from "@lorenzh/pulse-config/eslint.config.js";

// The Factory runner clones other repositories into .repos/; do not lint them.
export default [{ ignores: [".repos/**"] }, ...base];

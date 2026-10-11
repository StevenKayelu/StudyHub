// Same rules as the real configuration, but without excluding the fixtures folder.
const base = require('../../.dependency-cruiser.cjs');

module.exports = {
  ...base,
  options: {
    ...base.options,
    exclude: {
      path: base.options.exclude.path.filter((pattern) => !pattern.includes('boundary-fixtures')),
    },
  },
};

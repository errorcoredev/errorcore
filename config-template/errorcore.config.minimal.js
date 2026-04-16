// errorcore.config.js — minimal configuration
// For all options, run: npx errorcore init --full

module.exports = {
  // Local development: stdout prints captured errors to your terminal.
  // For production, switch to http or file transport.
  transport: { type: 'stdout' },

  // Set to false and provide an encryptionKey before deploying to production.
  // Generate a key: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  allowUnencrypted: true,
};

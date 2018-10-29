const { BaseKonnector } = require('cozy-konnector-libs')

module.exports = new BaseKonnector(start)

async function start() {
  throw new Error('MAINTENANCE')
}

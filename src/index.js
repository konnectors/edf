const { BaseKonnector } = require('cozy-konnector-libs')

module.exports = new BaseKonnector(start)

async function start(fields) {
  throw new Exception('MAINTENANCE')
}

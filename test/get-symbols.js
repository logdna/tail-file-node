'use strict'

module.exports = function getSymbols(classDef) {
  const symbols = {}
  for (const sym of Object.getOwnPropertySymbols(classDef)) {
    const symbolString = (sym.toString().match(/^Symbol\((\w+)\)/))[1]
    symbols[symbolString] = sym
  }
  return symbols
}

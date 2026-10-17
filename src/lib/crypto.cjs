const {
  createHmac,
  pbkdf2Sync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} = require('node:crypto')

const DEFAULT_ITERATIONS = 10000
const KEY_LENGTH = 32

function hashPassword(password, options = {}) {
  if (typeof password !== 'string') throw new TypeError('Password must be a string')

  const iterations = options.iterations || DEFAULT_ITERATIONS
  const salt = options.salt || randomBytes(16).toString('hex')
  const hash = derivePassword(password, salt, iterations).toString('hex')
  return `pbkdf2$sha256$${iterations}$${salt}$${hash}`
}

function verifyPassword(password, storedHash) {
  if (typeof password !== 'string' || typeof storedHash !== 'string') return false

  const parts = storedHash.split('$')
  if (parts.length !== 5) return false
  const [algorithm, digest, iterationsText, salt, expectedText] = parts
  if (algorithm !== 'pbkdf2' || digest !== 'sha256') return false
  if (!/^[0-9]+$/.test(iterationsText)) return false
  if (!isEvenHex(salt) || !isEvenHex(expectedText)) return false

  const iterations = Number(iterationsText)
  if (!Number.isSafeInteger(iterations) || iterations < 1) return false

  const expected = Buffer.from(expectedText, 'hex')
  const actual = derivePassword(password, salt, iterations)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function hmacSha256(key, data) {
  return createHmac('sha256', key).update(data).digest()
}

function derivePassword(password, salt, iterations) {
  return pbkdf2Sync(password, Buffer.from(salt, 'hex'), iterations, KEY_LENGTH, 'sha256')
}

function isEvenHex(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length % 2 === 0
    && /^[a-f0-9]+$/i.test(value)
}

module.exports = { hashPassword, hmacSha256, randomUUID, verifyPassword }

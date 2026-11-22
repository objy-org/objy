const {
  createHmac,
  pbkdf2,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} = require('node:crypto')

const DEFAULT_ITERATIONS = 600000
const KEY_LENGTH = 32
const MAX_PASSWORD_BYTES = 1024
const MAX_ITERATIONS = 1000000
const MAX_ACTIVE = 2
const MAX_WAITING = 32
const waiting = []
let active = 0

async function hashPassword(password, options = {}) {
  assertPassword(password)
  const iterations = options.iterations ?? DEFAULT_ITERATIONS
  const salt = options.salt ?? randomBytes(16).toString('hex')
  if (!validParameters(iterations, salt)) {
    throw new TypeError('Invalid password hash parameters')
  }
  const hash = (await derivePassword(password, salt, iterations)).toString('hex')
  return `pbkdf2$sha256$${iterations}$${salt}$${hash}`
}

async function verifyPassword(password, storedHash) {
  if (typeof password !== 'string' || Buffer.byteLength(password) > MAX_PASSWORD_BYTES) return false
  const parsed = parsePasswordHash(storedHash)
  if (!parsed) return false
  const actual = await derivePassword(password, parsed.salt, parsed.iterations)
  return timingSafeEqual(actual, Buffer.from(parsed.hash, 'hex'))
}

function parsePasswordHash(value) {
  if (typeof value !== 'string' || value.length > 220) return null
  const parts = value.split('$')
  if (parts.length !== 5 || parts[0] !== 'pbkdf2' || parts[1] !== 'sha256') return null
  const iterations = Number(parts[2])
  if (!/^[1-9][0-9]{0,6}$/.test(parts[2]) || !validParameters(iterations, parts[3])) return null
  if (!/^[a-f0-9]{64}$/i.test(parts[4])) return null
  return { iterations, salt: parts[3], hash: parts[4] }
}

function validParameters(iterations, salt) {
  return Number.isSafeInteger(iterations) && iterations >= 1 && iterations <= MAX_ITERATIONS
    && typeof salt === 'string' && salt.length >= 32 && salt.length <= 128
    && salt.length % 2 === 0 && /^[a-f0-9]+$/i.test(salt)
}

function passwordNeedsUpgrade(value) {
  const parsed = parsePasswordHash(value)
  return parsed !== null && parsed.iterations < DEFAULT_ITERATIONS
}

function assertPassword(password) {
  if (typeof password !== 'string') throw new TypeError('Password must be a string')
  if (Buffer.byteLength(password) > MAX_PASSWORD_BYTES) {
    throw Object.assign(new Error(`Password must not exceed ${MAX_PASSWORD_BYTES} UTF-8 bytes`), { status: 400 })
  }
}

function hmacSha256(key, data) {
  return createHmac('sha256', key).update(data).digest()
}

function derivePassword(password, salt, iterations) {
  return new Promise((resolve, reject) => {
    const run = () => {
      active++
      pbkdf2(password, Buffer.from(salt, 'hex'), iterations, KEY_LENGTH, 'sha256', (error, hash) => {
        active--
        waiting.shift()?.()
        if (error) reject(error)
        else resolve(hash)
      })
    }
    if (active < MAX_ACTIVE) run()
    else if (waiting.length < MAX_WAITING) waiting.push(run)
    else reject(Object.assign(new Error('Password hashing is busy; retry later'), {
      status: 503, headers: { 'retry-after': '1' },
    }))
  })
}

module.exports = { assertPassword, hashPassword, hmacSha256, parsePasswordHash, passwordNeedsUpgrade, randomUUID, verifyPassword }

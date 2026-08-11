const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]

function randomUUID() {
  const crypto = _globalCrypto()
  if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID()

  const bytes = _randomBytes(16, { secure: false })
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  const hex = _bytesToHex(bytes)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function hashPassword(password, options = {}) {
  if (typeof password !== 'string') throw new TypeError('Password must be a string')

  const iterations = options.iterations || 10000
  const salt = options.salt || _bytesToHex(_randomBytes(16, { secure: true }))
  const hash = _bytesToHex(_pbkdf2Sha256(_utf8(password), _hexToBytes(salt), iterations, 32))
  return `pbkdf2$sha256$${iterations}$${salt}$${hash}`
}

function verifyPassword(password, storedHash) {
  if (typeof password !== 'string' || typeof storedHash !== 'string') return false

  const parts = storedHash.split('$')
  if (parts.length !== 5) return false
  const [algorithm, digest, iterationsText, salt, expected] = parts
  if (algorithm !== 'pbkdf2' || digest !== 'sha256') return false
  if (!/^[0-9]+$/.test(iterationsText)) return false
  if (!/^[a-f0-9]+$/i.test(salt) || !/^[a-f0-9]+$/i.test(expected)) return false
  if (salt.length % 2 !== 0 || expected.length % 2 !== 0 || expected.length === 0) return false

  const iterations = Number(iterationsText)
  if (!Number.isSafeInteger(iterations) || iterations < 1) return false

  const actual = hashPassword(password, { iterations, salt }).split('$')[4]
  return _constantTimeEqual(_hexToBytes(actual), _hexToBytes(expected))
}

function hmacSha256(key, data) {
  return _hmacSha256(_utf8(key), _utf8(data))
}

function _pbkdf2Sha256(password, salt, iterations, keyLength) {
  const hashLength = 32
  const blocks = Math.ceil(keyLength / hashLength)
  const out = new Uint8Array(blocks * hashLength)

  for (let block = 1; block <= blocks; block++) {
    const blockSalt = new Uint8Array(salt.length + 4)
    blockSalt.set(salt)
    blockSalt[salt.length] = (block >>> 24) & 0xff
    blockSalt[salt.length + 1] = (block >>> 16) & 0xff
    blockSalt[salt.length + 2] = (block >>> 8) & 0xff
    blockSalt[salt.length + 3] = block & 0xff

    let u = _hmacSha256(password, blockSalt)
    const t = new Uint8Array(u)

    for (let i = 1; i < iterations; i++) {
      u = _hmacSha256(password, u)
      for (let j = 0; j < hashLength; j++) t[j] ^= u[j]
    }

    out.set(t, (block - 1) * hashLength)
  }

  return out.slice(0, keyLength)
}

function _hmacSha256(key, data) {
  const blockSize = 64
  let k = key.length > blockSize ? _sha256(key) : new Uint8Array(key)
  if (k.length < blockSize) {
    const padded = new Uint8Array(blockSize)
    padded.set(k)
    k = padded
  }

  const ipad = new Uint8Array(blockSize)
  const opad = new Uint8Array(blockSize)
  for (let i = 0; i < blockSize; i++) {
    ipad[i] = k[i] ^ 0x36
    opad[i] = k[i] ^ 0x5c
  }

  return _sha256(_concat(opad, _sha256(_concat(ipad, data))))
}

function _sha256(input) {
  const bytes = input instanceof Uint8Array ? input : _utf8(String(input))
  const bitLength = bytes.length * 8
  const paddedLength = (((bytes.length + 9 + 63) >> 6) << 6)
  const padded = new Uint8Array(paddedLength)
  padded.set(bytes)
  padded[bytes.length] = 0x80

  const view = new DataView(padded.buffer)
  view.setUint32(paddedLength - 4, bitLength >>> 0)
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000))

  let h0 = 0x6a09e667
  let h1 = 0xbb67ae85
  let h2 = 0x3c6ef372
  let h3 = 0xa54ff53a
  let h4 = 0x510e527f
  let h5 = 0x9b05688c
  let h6 = 0x1f83d9ab
  let h7 = 0x5be0cd19
  const w = new Uint32Array(64)

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = _rotr(w[i - 15], 7) ^ _rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = _rotr(w[i - 2], 17) ^ _rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }

    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    let f = h5
    let g = h6
    let h = h7

    for (let i = 0; i < 64; i++) {
      const s1 = _rotr(e, 6) ^ _rotr(e, 11) ^ _rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (h + s1 + ch + SHA256_K[i] + w[i]) >>> 0
      const s0 = _rotr(a, 2) ^ _rotr(a, 13) ^ _rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (s0 + maj) >>> 0
      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }

    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
    h5 = (h5 + f) >>> 0
    h6 = (h6 + g) >>> 0
    h7 = (h7 + h) >>> 0
  }

  const out = new Uint8Array(32)
  const outView = new DataView(out.buffer)
  ;[h0, h1, h2, h3, h4, h5, h6, h7].forEach((value, i) => outView.setUint32(i * 4, value))
  return out
}

function _randomBytes(length, { secure }) {
  const bytes = new Uint8Array(length)
  const crypto = _globalCrypto()
  if (crypto && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
    return bytes
  }
  if (secure) throw new Error('Secure random values are not available in this environment')
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  return bytes
}

function _globalCrypto() {
  return typeof globalThis !== 'undefined' ? globalThis.crypto : null
}

function _utf8(value) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value)

  const out = []
  for (let i = 0; i < value.length; i++) {
    let code = value.charCodeAt(i)
    if (code < 0x80) out.push(code)
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i)
      code = 0x10000 + (((code & 0x3ff) << 10) | (next & 0x3ff))
      out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    }
  }
  return new Uint8Array(out)
}

function _bytesToHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

function _hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

function _concat(a, b) {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

function _constantTimeEqual(a, b) {
  let diff = a.length ^ b.length
  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i++) {
    diff |= (a[i % a.length] || 0) ^ (b[i % b.length] || 0)
  }
  return diff === 0
}

function _rotr(value, shift) {
  return (value >>> shift) | (value << (32 - shift))
}

module.exports = { hashPassword, hmacSha256, randomUUID, verifyPassword }

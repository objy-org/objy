const { hmacSha256, randomUUID } = require('./crypto.cjs')

function signAccessToken(user, secret, { expiresInSeconds = 3600, sessionId = null, extraClaims = {} } = {}) {
  const data = user && user._data ? user._data : user
  if (!data || typeof data !== 'object') throw new TypeError('JWT user payload must be an object')

  const now = Math.floor(Date.now() / 1000)
  const id = sessionId || data.sessionId || randomUUID()
  return sign({
    typ: 'access',
    sub: data._id,
    userFamily: data.role,
    username: data.username,
    applications: data.applications || [],
    authorisations: data.authorisations || {},
    sessionId: id,
    tokenVersion: data.tokenVersion || 0,
    ..._safeExtraClaims(extraClaims),
    iat: now,
    exp: now + expiresInSeconds
  }, secret)
}

function signRefreshToken(user, secret, { expiresInSeconds = 1209600, sessionId = null, extraClaims = {} } = {}) {
  const data = user && user._data ? user._data : user
  if (!data || typeof data !== 'object') throw new TypeError('JWT user payload must be an object')

  const now = Math.floor(Date.now() / 1000)
  const id = sessionId || data.sessionId || randomUUID()
  return sign({
    typ: 'refresh',
    sub: data._id,
    userFamily: data.role,
    username: data.username,
    sessionId: id,
    tokenVersion: data.tokenVersion || 0,
    ..._safeExtraClaims(extraClaims),
    iat: now,
    exp: now + expiresInSeconds
  }, secret)
}

function sign(payload, secret) {
  _assertSecret(secret)
  const header = { alg: 'HS256', typ: 'JWT' }
  const unsigned = `${_encodeJson(header)}.${_encodeJson(payload)}`
  return `${unsigned}.${_base64UrlEncodeBytes(hmacSha256(secret, unsigned))}`
}

function verifyAccessToken(token, secret, options = {}) {
  const payload = verify(token, secret, options)
  if (payload.typ !== 'access') {
    const err = new Error('JWT is not an access token')
    err.code = 'E_INVALID_TOKEN'
    throw err
  }
  return payload
}

function verifyRefreshToken(token, secret, options = {}) {
  const payload = verify(token, secret, options)
  if (payload.typ !== 'refresh') {
    const err = new Error('JWT is not a refresh token')
    err.code = 'E_INVALID_TOKEN'
    throw err
  }
  return payload
}

function verify(token, secret, { clockToleranceSeconds = 0 } = {}) {
  _assertSecret(secret)
  if (typeof token !== 'string') {
    const err = new Error('JWT must be a string')
    err.code = 'E_INVALID_TOKEN'
    throw err
  }

  const parts = token.split('.')
  if (parts.length !== 3) {
    const err = new Error('JWT must have three parts')
    err.code = 'E_INVALID_TOKEN'
    throw err
  }

  const [headerPart, payloadPart, signaturePart] = parts
  const header = _decodeJson(headerPart)
  if (header.alg !== 'HS256' || header.typ !== 'JWT') {
    const err = new Error('Unsupported JWT header')
    err.code = 'E_INVALID_TOKEN'
    throw err
  }

  const unsigned = `${headerPart}.${payloadPart}`
  const expected = _base64UrlEncodeBytes(hmacSha256(secret, unsigned))
  if (!_constantTimeStringEqual(signaturePart, expected)) {
    const err = new Error('Invalid JWT signature')
    err.code = 'E_INVALID_TOKEN'
    throw err
  }

  const payload = _decodeJson(payloadPart)
  const now = Math.floor(Date.now() / 1000)
  if (typeof payload.exp !== 'number' || payload.exp + clockToleranceSeconds < now) {
    const err = new Error('JWT expired')
    err.code = 'E_TOKEN_EXPIRED'
    throw err
  }
  if (payload.iat !== undefined && typeof payload.iat !== 'number') {
    const err = new Error('Invalid JWT iat')
    err.code = 'E_INVALID_TOKEN'
    throw err
  }

  return payload
}

function _assertSecret(secret) {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new TypeError('JWT secret must be a non-empty string')
  }
}

function _safeExtraClaims(extraClaims) {
  if (!extraClaims || typeof extraClaims !== 'object' || Array.isArray(extraClaims)) return {}
  const reserved = new Set([
    'typ', 'sub', 'userFamily', 'username', 'applications', 'authorisations',
    'sessionId', 'tokenVersion', 'iat', 'exp'
  ])
  return Object.fromEntries(
    Object.entries(extraClaims).filter(([key]) => !reserved.has(key))
  )
}

function _encodeJson(value) {
  return _base64UrlEncodeBytes(_utf8(JSON.stringify(value)))
}

function _decodeJson(value) {
  try {
    return JSON.parse(_utf8Decode(_base64UrlDecodeBytes(value)))
  } catch {
    const err = new Error('Invalid JWT JSON')
    err.code = 'E_INVALID_TOKEN'
    throw err
  }
}

function _base64UrlEncodeBytes(bytes) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]
    const b = bytes[i + 1] || 0
    const c = bytes[i + 2] || 0
    const triplet = (a << 16) | (b << 8) | c
    out += alphabet[(triplet >>> 18) & 0x3f]
    out += alphabet[(triplet >>> 12) & 0x3f]
    if (i + 1 < bytes.length) out += alphabet[(triplet >>> 6) & 0x3f]
    if (i + 2 < bytes.length) out += alphabet[triplet & 0x3f]
  }
  return out
}

function _base64UrlDecodeBytes(value) {
  if (typeof value !== 'string') throw new TypeError('base64url value must be a string')
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const bytes = []
  let buffer = 0
  let bits = 0

  for (const char of value) {
    const idx = alphabet.indexOf(char)
    if (idx < 0) throw new Error('Invalid base64url character')
    buffer = (buffer << 6) | idx
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >>> bits) & 0xff)
    }
  }

  return new Uint8Array(bytes)
}

function _constantTimeStringEqual(a, b) {
  let diff = a.length ^ b.length
  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i++) {
    diff |= (a.charCodeAt(i % a.length) || 0) ^ (b.charCodeAt(i % b.length) || 0)
  }
  return diff === 0
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

function _utf8Decode(bytes) {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(bytes)

  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]
    if (byte < 0x80) out += String.fromCharCode(byte)
    else if (byte < 0xe0) out += String.fromCharCode(((byte & 0x1f) << 6) | (bytes[++i] & 0x3f))
    else if (byte < 0xf0) out += String.fromCharCode(((byte & 0x0f) << 12) | ((bytes[++i] & 0x3f) << 6) | (bytes[++i] & 0x3f))
    else {
      const code = ((byte & 0x07) << 18) | ((bytes[++i] & 0x3f) << 12) | ((bytes[++i] & 0x3f) << 6) | (bytes[++i] & 0x3f)
      const pair = code - 0x10000
      out += String.fromCharCode(0xd800 + (pair >> 10), 0xdc00 + (pair & 0x3ff))
    }
  }
  return out
}

module.exports = { signAccessToken, signRefreshToken, sign, verifyAccessToken, verifyRefreshToken, verify }

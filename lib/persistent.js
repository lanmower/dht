const c = require('compact-encoding')
const sodium = require('sodium-universal')
const RecordCache = require('record-cache')
const Cache = require('xache')
const m = require('./messages')
const { NS, ERROR } = require('./constants')

const EMPTY = Buffer.alloc(0)
const TMP = Buffer.allocUnsafe(32)

const rawArray = c.array(c.raw)

module.exports = class Persistent {
  constructor (dht, { maxSize, maxAge }) {
    this.dht = dht
    // TODO: should prob be more clear about maxSize here since to make many caches
    this.records = new RecordCache({ maxSize, maxAge })
    this.refreshes = new Cache({ maxSize, maxAge })
    this.mutables = new Cache({ maxSize: Math.floor(maxSize / 2), maxAge })
    this.immutables = new Cache({ maxSize: Math.floor(maxSize / 2), maxAge })
  }

  onlookup (req) {
    if (!req.target) return

    const k = req.target.toString('hex')
    const records = this.records.get(k, 20)
    const fwd = this.dht._router.get(k)

    if (fwd && records.length < 20) records.push(fwd.record)

    req.reply(records.length ? c.encode(rawArray, records) : null)
  }

  onfindpeer (req) {
    if (!req.target) return
    const fwd = this.dht._router.get(req.target)
    req.reply(fwd ? fwd.record : null)
  }

  unannounce (target, publicKey) {
    const k = target.toString('hex')
    sodium.crypto_generichash(TMP, publicKey)

    if (TMP.equals(target)) this.dht._router.delete(k)
    this.records.remove(k, publicKey)
  }

  onunannounce (req) {
    if (!req.target || !req.token) return

    const unann = decode(m.announce, req.value)
    if (unann === null) return

    const { peer, signature } = unann
    if (!peer || !signature) return

    const signable = annSignable(req.target, req.token, this.dht.id, unann, NS.UNANNOUNCE)

    if (!sodium.crypto_sign_verify_detached(signature, signable, peer.publicKey)) {
      return
    }

    this.unannounce(req.target, peer.publicKey)
    req.reply(null, { token: false, closerNodes: false })
  }

  _onrefresh (token, req) {
    sodium.crypto_generichash(TMP, token)
    const activeRefresh = TMP.toString('hex')

    const r = this.refreshes.get(activeRefresh)
    if (!r) return

    const { announceSelf, k, record } = r
    const publicKey = record.subarray(0, 32)

    if (announceSelf) {
      this.dht._router.set(k, {
        relay: req.from,
        record,
        onconnect: null,
        onholepunch: null
      })
      this.records.remove(k, publicKey)
    } else {
      this.records.add(k, publicKey, record)
    }

    this.refreshes.delete(activeRefresh)
    this.refreshes.set(token.toString('hex'), r)

    req.reply(null, { token: false, closerNodes: false })
  }

  onannounce (req) {
    if (!req.target || !req.token) return

    const ann = decode(m.announce, req.value)
    if (ann === null) return

    const signable = annSignable(req.target, req.token, this.dht.id, ann, NS.ANNOUNCE)
    const { peer, refresh, signature } = ann

    if (!peer) {
      if (!refresh) return
      this._onrefresh(refresh, req)
      return
    }

    if (!signature || !sodium.crypto_sign_verify_detached(signature, signable, peer.publicKey)) {
      return
    }

    // TODO: it would be potentially be more optimal to allow more than 3 addresses here for a findPeer response
    // and only use max 3 for a lookup reply
    if (peer.relayAddresses.length > 3) {
      peer.relayAddresses = peer.relayAddresses.slice(0, 3)
    }

    sodium.crypto_generichash(TMP, peer.publicKey)

    const k = req.target.toString('hex')
    const announceSelf = TMP.equals(req.target)
    const record = c.encode(m.peer, peer)

    if (announceSelf) {
      this.dht._router.set(k, {
        relay: req.from,
        record,
        onconnect: null,
        onholepunch: null
      })
      this.records.remove(k, peer.publicKey)
    } else {
      this.records.add(k, peer.publicKey, record)
    }

    if (refresh) {
      this.refreshes.set(refresh.toString('hex'), { k, record, announceSelf })
    }

    req.reply(null, { token: false, closerNodes: false })
  }

  onmutableget (req) {
    if (!req.target || !req.value) return

    let seq = 0
    try {
      seq = c.decode(c.uint, req.value)
    } catch {
      return
    }

    const k = req.target.toString('hex')
    const value = this.mutables.get(k)

    if (!value) {
      req.reply(null)
      return
    }

    const localSeq = c.decode(c.uint, value)
    req.reply(localSeq < seq ? null : value)
  }

  onmutableput (req) {
    if (!req.target || !req.token || !req.value) return

    const p = decode(m.mutablePutRequest, req.value)
    if (!p) return

    const { publicKey, seq, value, signature } = p

    const hash = Buffer.allocUnsafe(32)
    sodium.crypto_generichash(hash, publicKey)
    if (!hash.equals(req.target)) return

    if (!value || !verifyMutable(signature, seq, value, publicKey)) return

    const k = hash.toString('hex')
    const local = this.mutables.get(k)

    if (local) {
      const existing = c.encode(m.mutableGetResponse, local)
      if (existing.value && existing.seq === seq && Buffer.compare(value, existing.value) !== 0) {
        req.error(ERROR.SEQ_REUSED)
        return
      }
      if (seq < existing.seq) {
        req.error(ERROR.SEQ_TOO_LOW)
        return
      }
    }

    this.mutables.set(k, c.encode(m.mutableGetResponse, { seq, value, signature }))
    req.reply(null)
  }

  onimmutableget (req) {
    if (!req.target) return

    const k = req.target.toString('hex')
    const value = this.immutables.get(k)

    req.reply(value || null)
  }

  onimmutableput (req) {
    if (!req.target || !req.token || !req.value) return

    const hash = Buffer.alloc(32)
    sodium.crypto_generichash(hash, req.value)
    if (!hash.equals(req.target)) return

    const k = hash.toString('hex')
    this.immutables.set(k, req.value)

    req.reply(null)
  }

  static signMutable (seq, value, secretKey) {
    const signature = Buffer.allocUnsafe(64)
    const signable = Buffer.allocUnsafe(32)
    sodium.crypto_generichash(signable, c.encode(m.mutableSignable, { seq, value }), NS.MUTABLE_PUT)
    sodium.crypto_sign_detached(signature, signable, secretKey)
    return signature
  }

  static verifyMutable (signature, seq, value, publicKey) {
    return verifyMutable(signature, seq, value, publicKey)
  }

  static signAnnounce (target, token, id, ann, secretKey) {
    const signature = Buffer.allocUnsafe(64)
    sodium.crypto_sign_detached(signature, annSignable(target, token, id, ann, NS.ANNOUNCE), secretKey)
    return signature
  }

  static signUnannounce (target, token, id, ann, secretKey) {
    const signature = Buffer.allocUnsafe(64)
    sodium.crypto_sign_detached(signature, annSignable(target, token, id, ann, NS.UNANNOUNCE), secretKey)
    return signature
  }
}

function verifyMutable (signature, seq, value, publicKey) {
  const signable = Buffer.allocUnsafe(32)
  sodium.crypto_generichash(signable, c.encode(m.mutableSignable, { seq, value }), NS.MUTABLE_PUT)
  return sodium.crypto_sign_verify_detached(signature, signable, publicKey)
}

function annSignable (target, token, id, ann, ns) {
  const hash = Buffer.allocUnsafe(32)

  sodium.crypto_generichash_batch(hash, [
    target,
    id,
    token,
    c.encode(m.peer, ann.peer), // note that this is the partial encoding of the announce message so we could just use that for perf
    ann.refresh || EMPTY
  ], ns)

  return hash
}

function decode (enc, val) {
  try {
    return val && c.decode(enc, val)
  } catch (err) {
    return null
  }
}
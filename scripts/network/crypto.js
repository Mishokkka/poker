function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function validateEcdhPublicKey(peerKeyEnvelope) {
  const subtle = globalThis.crypto?.subtle;
  const jwk = peerKeyEnvelope?.jwk;
  if (!subtle || peerKeyEnvelope?.mode !== "ecdh" || !jwk || typeof jwk !== "object" || Array.isArray(jwk)) return false;
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || !jwk.x || typeof jwk.y !== "string" || !jwk.y) return false;

  try {
    const key = await subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      []
    );
    return key.type === "public" && key.algorithm?.name === "ECDH" && key.algorithm?.namedCurve === "P-256";
  } catch {
    return false;
  }
}

function privateTransportError(cause = null) {
  const error = new Error("FBLPoker.Errors.PrivateTransportUnavailable");
  if (cause) error.cause = cause;
  return error;
}

/**
 * Private poker payloads require ECDH/AES-GCM. The transport deliberately
 * fails closed when Web Crypto is unavailable because Foundry module socket
 * payloads are broadcast to every connected client before recipient checks.
 */
export class SessionCrypto {
  #keyPair = null;
  #publicJwk = null;
  #secure = false;

  async initialize() {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) throw privateTransportError();

    try {
      this.#keyPair = await subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveKey"]
      );
      const jwk = await subtle.exportKey("jwk", this.#keyPair.publicKey);
      this.#publicJwk = { mode: "ecdh", jwk };
      this.#secure = true;
    } catch (error) {
      this.#keyPair = null;
      this.#publicJwk = null;
      this.#secure = false;
      throw privateTransportError(error);
    }
  }

  get publicKey() {
    return this.#publicJwk;
  }

  get secure() {
    return this.#secure;
  }

  async #derive(peerKeyEnvelope, usage) {
    const subtle = globalThis.crypto?.subtle;
    if (!this.#secure || !this.#keyPair || !subtle) throw privateTransportError();
    if (peerKeyEnvelope?.mode !== "ecdh" || !peerKeyEnvelope.jwk || typeof peerKeyEnvelope.jwk !== "object") {
      throw privateTransportError();
    }

    try {
      const peerKey = await subtle.importKey(
        "jwk",
        peerKeyEnvelope.jwk,
        { name: "ECDH", namedCurve: "P-256" },
        false,
        []
      );
      return await subtle.deriveKey(
        { name: "ECDH", public: peerKey },
        this.#keyPair.privateKey,
        { name: "AES-GCM", length: 256 },
        false,
        [usage]
      );
    } catch (error) {
      throw privateTransportError(error);
    }
  }

  async encrypt(peerKeyEnvelope, value) {
    const key = await this.#derive(peerKeyEnvelope, "encrypt");
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(JSON.stringify(value));
    const ciphertext = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded));
    return { iv: bytesToBase64(iv), ciphertext: bytesToBase64(ciphertext) };
  }

  async decrypt(peerKeyEnvelope, payload) {
    if (!payload || typeof payload.iv !== "string" || typeof payload.ciphertext !== "string") {
      throw privateTransportError();
    }
    const key = await this.#derive(peerKeyEnvelope, "decrypt");
    try {
      const decoded = await globalThis.crypto.subtle.decrypt(
        { name: "AES-GCM", iv: base64ToBytes(payload.iv) },
        key,
        base64ToBytes(payload.ciphertext)
      );
      return JSON.parse(new TextDecoder().decode(decoded));
    } catch (error) {
      throw privateTransportError(error);
    }
  }
}

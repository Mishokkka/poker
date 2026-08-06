function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/**
 * Private poker payloads use ECDH/AES-GCM whenever Web Crypto is available.
 * Foundry is commonly opened by remote players over plain HTTP, where
 * crypto.subtle is unavailable. In that environment the transport falls back
 * to recipient-targeted plain payloads instead of preventing the module from
 * connecting at all.
 */
export class SessionCrypto {
  #keyPair = null;
  #publicJwk = { mode: "plain" };
  #secure = false;

  async initialize() {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) {
      console.warn("FBL Poker | Web Crypto is unavailable; using HTTP compatibility transport for private payloads.");
      this.#secure = false;
      this.#publicJwk = { mode: "plain" };
      return;
    }

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
      console.warn("FBL Poker | Web Crypto is unavailable; using compatibility transport.", error);
      this.#keyPair = null;
      this.#publicJwk = { mode: "plain" };
      this.#secure = false;
    }
  }

  get publicKey() {
    return this.#publicJwk;
  }

  get secure() {
    return this.#secure;
  }

  async #derive(peerJwk, usage) {
    if (!this.#secure || !this.#keyPair || peerJwk?.mode === "plain") return null;
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return null;
    const publicJwk = peerJwk?.jwk ?? peerJwk;
    const peerKey = await subtle.importKey(
      "jwk",
      publicJwk,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      []
    );
    return subtle.deriveKey(
      { name: "ECDH", public: peerKey },
      this.#keyPair.privateKey,
      { name: "AES-GCM", length: 256 },
      false,
      [usage]
    );
  }

  async encrypt(peerJwk, value) {
    const key = await this.#derive(peerJwk, "encrypt");
    if (!key) return { plain: value };
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(JSON.stringify(value));
    const ciphertext = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded));
    return { iv: bytesToBase64(iv), ciphertext: bytesToBase64(ciphertext) };
  }

  async decrypt(peerJwk, payload) {
    if (payload && Object.prototype.hasOwnProperty.call(payload, "plain")) return payload.plain;
    const key = await this.#derive(peerJwk, "decrypt");
    if (!key) throw new Error("FBLPoker.Errors.PrivateTransportUnavailable");
    const decoded = await globalThis.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(payload.iv) },
      key,
      base64ToBytes(payload.ciphertext)
    );
    return JSON.parse(new TextDecoder().decode(decoded));
  }
}

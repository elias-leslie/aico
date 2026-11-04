package dev.summitflow.nightshift.crypto

import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

class DecryptException(message: String) : Exception(message)

/**
 * RFC 8291 aes128gcm, one record, as Web Push sends it. The ECDH step is injected so the device
 * runs it inside the Android Keystore and tests run it with a software key.
 */
object Rfc8291 {
    private const val HEADER_FIXED = 21 // salt 16 + record size 4 + key id length 1
    private const val TAG = 16

    private val KEY_INFO_PREFIX = "WebPush: info\u0000".toByteArray(Charsets.US_ASCII)
    private val CEK_INFO = "Content-Encoding: aes128gcm\u0000".toByteArray(Charsets.US_ASCII)
    private val NONCE_INFO = "Content-Encoding: nonce\u0000".toByteArray(Charsets.US_ASCII)

    /**
     * @param ct the raw bytes of the base64url `ct` field
     * @param uaPublic this device's 65-byte enc public key
     * @param auth the 16-byte auth secret
     * @param agree ECDH(enc private key, peer 65-byte public key) -> shared secret
     */
    fun decrypt(ct: ByteArray, uaPublic: ByteArray, auth: ByteArray, agree: (ByteArray) -> ByteArray): ByteArray {
        if (ct.size < HEADER_FIXED + 65 + TAG + 1) throw DecryptException("short message")
        val salt = ct.copyOfRange(0, 16)
        val rs = ((ct[16].toLong() and 0xff) shl 24) or ((ct[17].toLong() and 0xff) shl 16) or
            ((ct[18].toLong() and 0xff) shl 8) or (ct[19].toLong() and 0xff)
        val idLen = ct[20].toInt() and 0xff
        if (idLen != 65) throw DecryptException("bad key id length")
        if (rs < TAG + 2) throw DecryptException("bad record size")
        val start = HEADER_FIXED + idLen
        val body = ct.copyOfRange(start, ct.size)
        if (body.size.toLong() > rs) throw DecryptException("more than one record")
        val asPublic = ct.copyOfRange(HEADER_FIXED, start)

        val secret = try {
            agree(asPublic)
        } catch (e: Exception) {
            throw DecryptException("key agreement failed")
        }
        val prkKey = Hkdf.extract(auth, secret)
        val ikm = Hkdf.expand(prkKey, KEY_INFO_PREFIX + uaPublic + asPublic, 32)
        val prk = Hkdf.extract(salt, ikm)
        val cek = Hkdf.expand(prk, CEK_INFO, 16)
        val nonce = Hkdf.expand(prk, NONCE_INFO, 12)

        val padded = try {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, SecretKeySpec(cek, "AES"), GCMParameterSpec(128, nonce))
            c.doFinal(body)
        } catch (e: Exception) {
            throw DecryptException("authentication failed")
        }
        var i = padded.size - 1
        while (i >= 0 && padded[i] == 0.toByte()) i--
        if (i < 0 || padded[i] != 2.toByte()) throw DecryptException("bad padding")
        return padded.copyOf(i)
    }
}

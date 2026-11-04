package dev.summitflow.nightshift.crypto

import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** RFC 5869 over HMAC-SHA256. */
object Hkdf {
    private const val HASH_LEN = 32

    fun extract(salt: ByteArray, ikm: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(if (salt.isEmpty()) ByteArray(HASH_LEN) else salt, "HmacSHA256"))
        return mac.doFinal(ikm)
    }

    fun expand(prk: ByteArray, info: ByteArray, length: Int): ByteArray {
        val n = (length + HASH_LEN - 1) / HASH_LEN
        require(n in 1..255) { "bad HKDF length" }
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(prk, "HmacSHA256"))
        val out = ByteArray(length)
        var t = ByteArray(0)
        var off = 0
        for (i in 1..n) {
            mac.update(t)
            mac.update(info)
            mac.update(i.toByte())
            t = mac.doFinal()
            val c = minOf(HASH_LEN, length - off)
            System.arraycopy(t, 0, out, off, c)
            off += c
        }
        return out
    }
}

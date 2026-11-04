package dev.summitflow.nightshift.crypto

import java.security.MessageDigest
import java.util.Base64

/** base64url without padding, the only encoding the contract uses. */
object B64 {
    private val enc = Base64.getUrlEncoder().withoutPadding()
    private val dec = Base64.getUrlDecoder()

    fun encode(b: ByteArray): String = enc.encodeToString(b)
    fun decode(s: String): ByteArray = dec.decode(s)
    fun sha256(b: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(b)
}

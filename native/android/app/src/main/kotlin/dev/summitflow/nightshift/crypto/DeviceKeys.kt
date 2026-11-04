package dev.summitflow.nightshift.crypto

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import javax.crypto.KeyAgreement

/**
 * The two Android Keystore P-256 keys: sig signs requests, enc decrypts pushes. Neither leaves the chip.
 *
 * Keys live in one of two slots so a re-pair can make new keys beside the working ones and switch only once
 * home accepts them (the Keystore can't rename an alias). The config names the live slot; slot 0 keeps the
 * original alias names so existing pairings stay valid.
 */
object DeviceKeys {
    private val SLOTS = listOf(0, 1)

    private fun sigAlias(slot: Int) = if (slot == 0) "nightshift-sig" else "nightshift-sig-$slot"
    private fun encAlias(slot: Int) = if (slot == 0) "nightshift-enc" else "nightshift-enc-$slot"

    private fun ks(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    /** The slot a new pairing goes to while [live] keeps working. */
    fun spareSlot(live: Int?): Int = if (live == 0) 1 else 0

    /** Fresh keys in [slot], replacing whatever was left there. */
    fun create(slot: Int) {
        drop(slot)
        gen(sigAlias(slot), KeyProperties.PURPOSE_SIGN, sign = true)
        gen(encAlias(slot), KeyProperties.PURPOSE_AGREE_KEY, sign = false)
    }

    fun drop(slot: Int) {
        val k = ks()
        for (a in listOf(sigAlias(slot), encAlias(slot))) if (k.containsAlias(a)) k.deleteEntry(a)
    }

    fun dropAll() = SLOTS.forEach(::drop)

    private fun gen(alias: String, purposes: Int, sign: Boolean) {
        val b = KeyGenParameterSpec.Builder(alias, purposes)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
        if (sign) b.setDigests(KeyProperties.DIGEST_SHA256)
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply { initialize(b.build()) }.generateKeyPair()
    }

    private fun pub(alias: String): ByteArray = Ec.encode(ks().getCertificate(alias).publicKey as ECPublicKey)
    private fun priv(alias: String): PrivateKey = ks().getKey(alias, null) as PrivateKey

    fun sigPublic(slot: Int): ByteArray = pub(sigAlias(slot))
    fun encPublic(slot: Int): ByteArray = pub(encAlias(slot))

    /** base64url(sha256(raw sig public key)) cut to 22 characters. */
    fun deviceId(sigPublic: ByteArray): String = B64.encode(B64.sha256(sigPublic)).take(22)

    /** DER ECDSA-SHA256. */
    fun sign(slot: Int, data: ByteArray): ByteArray = Signature.getInstance("SHA256withECDSA").run {
        initSign(priv(sigAlias(slot))); update(data); sign()
    }

    /** ECDH inside the Keystore with the enc key. */
    fun agree(slot: Int, peer: ByteArray): ByteArray = KeyAgreement.getInstance("ECDH", "AndroidKeyStore").run {
        init(priv(encAlias(slot))); doPhase(Ec.decode(peer), true); generateSecret()
    }
}

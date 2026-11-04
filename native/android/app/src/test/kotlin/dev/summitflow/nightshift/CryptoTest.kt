package dev.summitflow.nightshift

import dev.summitflow.nightshift.crypto.B64
import dev.summitflow.nightshift.crypto.DecryptException
import dev.summitflow.nightshift.crypto.Ec
import dev.summitflow.nightshift.crypto.Hkdf
import dev.summitflow.nightshift.crypto.Rfc8291
import dev.summitflow.nightshift.model.Push
import dev.summitflow.nightshift.model.parseObject
import dev.summitflow.nightshift.model.str
import dev.summitflow.nightshift.net.Signing
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.math.BigInteger
import java.security.KeyFactory
import java.security.spec.ECPrivateKeySpec
import javax.crypto.KeyAgreement

class CryptoTest {
    private val vector = parseObject(javaClass.classLoader!!.getResource("rfc8291-vector.json")!!.readText())

    private fun softwareAgree(): (ByteArray) -> ByteArray {
        val d = BigInteger(1, B64.decode(vector.str("receiver_d")!!))
        val priv = KeyFactory.getInstance("EC").generatePrivate(ECPrivateKeySpec(d, Ec.params))
        return { peer ->
            KeyAgreement.getInstance("ECDH").run { init(priv); doPhase(Ec.decode(peer), true); generateSecret() }
        }
    }

    private fun decrypt(ct: ByteArray = B64.decode(vector.str("ct")!!), auth: ByteArray = B64.decode(vector.str("shared16")!!)) =
        Rfc8291.decrypt(ct, B64.decode(vector.str("receiver_pub")!!), auth, softwareAgree())

    @Test fun serverVectorDecryptsToItsPlaintext() {
        assertEquals(vector.str("plaintext"), String(decrypt(), Charsets.UTF_8))
    }

    @Test fun decryptedVectorParsesAsAnItemPush() {
        val p = Push.parse("m", decrypt()) as Push.ItemPush
        assertEquals("0123456789ab", p.item.id)
        assertEquals("n:0123456789ab", p.item.rowId)
        assertEquals("Body ü", p.item.body)
        assertEquals("critical", p.item.channel)
        assertEquals("Nightshift: critical", p.item.publicText)
        assertEquals(1, p.item.actions.size)
        assertEquals("open", p.item.actions[0].id)
        assertEquals("view", p.item.actions[0].tier)
    }

    @Test fun wrongAuthSecretFails() {
        try { decrypt(auth = ByteArray(16)); fail() } catch (e: DecryptException) { }
    }

    @Test fun flippedCiphertextByteFails() {
        val ct = B64.decode(vector.str("ct")!!)
        ct[ct.size - 5] = (ct[ct.size - 5].toInt() xor 1).toByte()
        try { decrypt(ct = ct); fail() } catch (e: DecryptException) { }
    }

    @Test fun truncatedAndMultiRecordMessagesAreRefused() {
        val ct = B64.decode(vector.str("ct")!!)
        try { decrypt(ct = ct.copyOf(40)); fail() } catch (e: DecryptException) { }
        val small = ct.copyOf(); small[18] = 0; small[19] = 100 // record size 100, body is longer
        try { decrypt(ct = small); fail() } catch (e: DecryptException) { }
    }

    @Test fun hkdfRfc5869Case1() {
        val ikm = ByteArray(22) { 0x0b }
        val salt = ByteArray(13) { it.toByte() }
        val info = ByteArray(10) { (0xf0 + it).toByte() }
        val okm = Hkdf.expand(Hkdf.extract(salt, ikm), info, 42)
        assertEquals(
            "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
            okm.joinToString("") { "%02x".format(it) },
        )
    }

    @Test fun canonicalStringMatchesTheServerVector() {
        val s = Signing.canonical("POST", "/api/app/ack", 1793480000, "{\"a\":1}".toByteArray())
        assertEquals("POST\n/api/app/ack\n1793480000\nAVq9f1zFei3ZS3WQ8ErYCEJzkF7jPsXOvq5iJ2qX-GI", s)
    }

    @Test fun canonicalStringKeepsQueryAndHashesEmptyGetBody() {
        val s = Signing.canonical("GET", "/api/app/items?x=1", 5, ByteArray(0))
        assertEquals("GET\n/api/app/items?x=1\n5\n47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU", s)
    }

    @Test fun ecRoundTripAndBase64Url() {
        val raw = B64.decode(vector.str("receiver_pub")!!)
        assertEquals(65, raw.size)
        assertArrayEquals(raw, Ec.encode(Ec.decode(raw)))
        assertTrue(!B64.encode(raw).contains('='))
    }
}

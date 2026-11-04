package dev.summitflow.nightshift.crypto

import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec

/** P-256 public keys as the 65-byte uncompressed point. */
object Ec {
    val params: ECParameterSpec by lazy {
        val p = AlgorithmParameters.getInstance("EC")
        p.init(ECGenParameterSpec("secp256r1"))
        p.getParameterSpec(ECParameterSpec::class.java)
    }

    fun encode(key: ECPublicKey): ByteArray {
        val out = ByteArray(65)
        out[0] = 4
        System.arraycopy(fixed32(key.w.affineX), 0, out, 1, 32)
        System.arraycopy(fixed32(key.w.affineY), 0, out, 33, 32)
        return out
    }

    fun decode(bytes: ByteArray): ECPublicKey {
        require(bytes.size == 65 && bytes[0] == 4.toByte()) { "not an uncompressed P-256 point" }
        val point = ECPoint(BigInteger(1, bytes.copyOfRange(1, 33)), BigInteger(1, bytes.copyOfRange(33, 65)))
        return KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(point, params)) as ECPublicKey
    }

    private fun fixed32(v: BigInteger): ByteArray {
        val raw = v.toByteArray()
        if (raw.size == 32) return raw
        val out = ByteArray(32)
        if (raw.size > 32) System.arraycopy(raw, raw.size - 32, out, 0, 32)
        else System.arraycopy(raw, 0, out, 32 - raw.size, raw.size)
        return out
    }
}

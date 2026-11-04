package dev.summitflow.nightshift.model

import dev.summitflow.nightshift.crypto.B64
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

class PairingException(message: String) : Exception(message)

data class FcmConfig(val projectId: String, val appId: String, val apiKey: String, val senderId: String) {
    fun toJson(): JsonObject = buildJsonObject {
        put("project_id", projectId); put("app_id", appId); put("api_key", apiKey); put("sender_id", senderId)
    }

    companion object {
        fun parse(o: JsonObject): FcmConfig? {
            fun f(k: String) = o.str(k)?.takeIf { it.isNotBlank() }
            return FcmConfig(f("project_id") ?: return null, f("app_id") ?: return null, f("api_key") ?: return null, f("sender_id") ?: return null)
        }
    }
}

data class Pairing(
    val base: String,
    val code: String,
    val cid: String,
    val csec: String,
    val origins: List<String>,
    val webLabel: String,
    val fcm: FcmConfig,
)

object PairingParser {
    private const val MAX_PAYLOAD = 8192

    /** `p` is the `p=` value of `nightshift://pair?p=...`. Anything off is refused with a plain reason. */
    fun parse(p: String?): Pairing {
        if (p.isNullOrBlank()) throw PairingException("The pairing link is empty.")
        if (p.length > MAX_PAYLOAD) throw PairingException("The pairing link is too long.")
        val o = try {
            parseObject(String(B64.decode(p.trim()), Charsets.UTF_8))
        } catch (e: Exception) {
            throw PairingException("The pairing link is damaged.")
        }
        if (o.long("v") != 1L) throw PairingException("The pairing link is from a different version.")
        val base = o.str("base")?.let(Origins::parseOrigin)
            ?: throw PairingException("The pairing link has no usable https address.")
        val code = o.str("code")?.takeIf { it.isNotBlank() } ?: throw PairingException("The pairing link has no code.")
        val cid = o.str("cid")?.takeIf { it.isNotBlank() } ?: throw PairingException("The pairing link has no access id.")
        val csec = o.str("csec")?.takeIf { it.isNotBlank() } ?: throw PairingException("The pairing link has no access secret.")
        val rawOrigins = o.arr("origins") ?: throw PairingException("The pairing link has no link allowlist.")
        val origins = rawOrigins.map {
            (it as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { p -> p.isString }?.content?.let(Origins::parseOrigin)
                ?: throw PairingException("The pairing link has a bad entry in its link allowlist.")
        }.distinct()
        if (origins.isEmpty()) throw PairingException("The pairing link has an empty link allowlist.")
        val fcm = o.obj("fcm")?.let(FcmConfig::parse) ?: throw PairingException("The pairing link has no push settings.")
        return Pairing(base, code, cid, csec, origins, (o.str("web_label") ?: "").take(80), fcm)
    }
}

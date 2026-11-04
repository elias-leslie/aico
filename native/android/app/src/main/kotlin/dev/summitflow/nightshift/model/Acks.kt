package dev.summitflow.nightshift.model

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** One entry of `POST /api/app/ack`. [error] only on `t` "e": the exception class of a push this phone couldn't read. */
data class PendingAck(val id: String, val t: String, val receivedAt: Long, val shown: Boolean, val error: String? = null) {
    fun toJson(): JsonObject = buildJsonObject {
        put("id", id); put("t", t); put("received_at", receivedAt); put("shown", shown)
        error?.let { put("error", it) }
    }

    companion object {
        /** `t` of an ack for a push that couldn't be decrypted or parsed; home then treats the app as not live. */
        const val UNREADABLE = "e"

        fun parse(o: JsonObject): PendingAck? = PendingAck(
            o.str("id") ?: return null, o.str("t") ?: return null,
            o.long("received_at") ?: 0, o.bool("shown") ?: false, o.str("error"),
        )

        /** [messageId] is FCM's id for the message (the payload's own id is unreadable). Class name only, no message text. */
        fun unreadable(messageId: String?, e: Throwable, receivedAt: Long, shown: Boolean) = PendingAck(
            id = messageId?.takeIf { it.isNotBlank() } ?: "unknown",
            t = UNREADABLE,
            receivedAt = receivedAt,
            shown = shown,
            error = e.javaClass.simpleName.ifBlank { e.javaClass.name },
        )

        /** [pending] minus exactly the acks in [sent] (by id and t), whatever was added or trimmed meanwhile. */
        fun without(pending: List<PendingAck>, sent: List<PendingAck>): List<PendingAck> {
            val gone = sent.mapTo(HashSet()) { it.id to it.t }
            return pending.filterNot { (it.id to it.t) in gone }
        }
    }
}

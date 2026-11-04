package dev.summitflow.nightshift.model

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** `url` set: open it in a Custom Tab (allowlisted origins only). No url: post it (net/Act: the item's act route). */
data class Action(val id: String, val label: String, val tier: String, val url: String?) {
    fun toJson(): JsonObject = buildJsonObject {
        put("id", id); put("label", label); put("tier", tier)
        if (url != null) put("url", url)
    }

    companion object {
        fun parse(o: JsonObject): Action? {
            val id = o.str("id")?.takeIf { it.isNotBlank() } ?: return null
            val url = o.str("url")?.takeIf { it.isNotBlank() }
            val label = o.str("label")?.takeIf { it.isNotBlank() } ?: id
            val tier = o.str("tier")?.takeIf { it in setOf("view", "plain", "key") }
                ?: if (url != null) "view" else "plain"
            return Action(id, label, tier, url)
        }
    }
}

/** One thing the server said: a Row from /api/app/items or a pushed `m` item. */
data class Item(
    val id: String,
    val title: String,
    val body: String,
    val detail: String? = null,
    val severity: String = "info",
    val state: String? = null,
    val ts: Long = 0,
    val age: String? = null,
    val url: String? = null,
    val actions: List<Action> = emptyList(),
    val channel: String? = null,
    val tag: String? = null,
    val group: String? = null,
    val kind: String? = null,
    val ends: Long? = null,
    val publicText: String? = null,
    val close: List<String> = emptyList(),
    /** The Row's `item`: what /api/app/items/<item>/act takes. Null on a row no item holds yet, and on a push. */
    val itemId: String? = null,
) {
    /** The id /api/app/act expects: rows carry k:/n:/a:/q: already, a pushed item's id is a log id. */
    val rowId: String get() = rowIdOf(id)

    fun toJson(): JsonObject = buildJsonObject {
        put("id", id); put("title", title); put("body", body)
        detail?.let { put("detail", it) }
        put("severity", severity)
        state?.let { put("state", it) }
        put("ts", ts)
        age?.let { put("age", it) }
        url?.let { put("url", it) }
        put("actions", JsonArray(actions.map { it.toJson() }))
        channel?.let { put("channel", it) }
        tag?.let { put("tag", it) }
        group?.let { put("group", it) }
        kind?.let { put("kind", it) }
        ends?.let { put("ends", it) }
        publicText?.let { put("public", it) }
        put("close", JsonArray(close.map { JsonPrimitive(it) }))
        itemId?.let { put("item", it) }
    }

    companion object {
        private val ROW_ID = Regex("^[knaq]:.+")

        fun rowIdOf(id: String): String = if (ROW_ID.matches(id)) id else "n:$id"

        /** Lenient: rows and pushed items share this shape. Null when there is no id or title. */
        fun parse(o: JsonObject): Item? {
            val id = o.str("id")?.takeIf { it.isNotBlank() } ?: return null
            val title = o.str("title") ?: return null
            return Item(
                id = id,
                title = title,
                body = o.str("body") ?: "",
                detail = o.str("detail")?.takeIf { it.isNotBlank() },
                severity = o.str("severity") ?: "info",
                state = o.str("state"),
                ts = o.long("ts") ?: 0,
                age = o.str("age"),
                url = o.str("url")?.takeIf { it.isNotBlank() },
                actions = o.arr("actions")?.mapNotNull { (it as? JsonObject)?.let(Action::parse) } ?: emptyList(),
                channel = o.str("channel"),
                tag = o.str("tag")?.takeIf { it.isNotBlank() },
                group = o.str("group")?.takeIf { it.isNotBlank() },
                kind = o.str("kind"),
                ends = o.long("ends"),
                publicText = o.str("public"),
                close = o.strings("close"),
                itemId = o.str("item")?.takeIf { it.isNotBlank() },
            )
        }
    }
}

/** Actions the app may show: https links only for listed origins, at most [max]. */
fun Item.usableActions(origins: List<String>, max: Int = Int.MAX_VALUE): List<Action> =
    actions.filter { it.url == null || Origins.allowed(it.url, origins) }.take(max)

data class Health(val ok: Boolean?, val now: Long?, val checkedAt: Long?, val phoneConfirmedAt: Long?, val line: String?) {
    fun toJson(): JsonObject = buildJsonObject {
        ok?.let { put("ok", it) }
        now?.let { put("now", it) }
        checkedAt?.let { put("checked_at", it) }
        phoneConfirmedAt?.let { put("phone_confirmed_at", it) }
        line?.let { put("line", it) }
    }

    companion object {
        fun parse(o: JsonObject) = Health(o.bool("ok"), o.long("now"), o.long("checked_at"), o.long("phone_confirmed_at"), o.str("line"))
    }
}

/** What the server said on /api/app/items, with when we heard it. */
data class ItemsSnapshot(val fetchedAt: Long, val health: Health?, val needsYou: List<Item>, val recent: List<Item>) {
    fun toJson(): JsonObject = buildJsonObject {
        put("fetched_at", fetchedAt)
        health?.let { put("health", it.toJson()) }
        put("needs_you", JsonArray(needsYou.map { it.toJson() }))
        put("recent", JsonArray(recent.map { it.toJson() }))
    }

    companion object {
        fun parse(o: JsonObject, fetchedAt: Long) = ItemsSnapshot(
            fetchedAt = fetchedAt,
            health = o.obj("health")?.let(Health::parse),
            needsYou = o.arr("needs_you")?.mapNotNull { (it as? JsonObject)?.let(Item::parse) } ?: emptyList(),
            recent = o.arr("recent")?.mapNotNull { (it as? JsonObject)?.let(Item::parse) } ?: emptyList(),
        )

        fun fromCache(o: JsonObject): ItemsSnapshot = parse(o, o.long("fetched_at") ?: 0)
    }

    /** The `item` of the row with [rowId] (a push's id finds its n: row), null when no row names one. */
    fun itemIdFor(rowId: String): String? {
        val ids = setOf(rowId, Item.rowIdOf(rowId))
        return (needsYou + recent).firstOrNull { it.id in ids && it.itemId != null }?.itemId
    }
}

/** A decrypted push, by the FCM `t`. */
sealed interface Push {
    val id: String
    data class ItemPush(val item: Item) : Push { override val id get() = item.id }
    data class Close(override val id: String, val tags: List<String>) : Push
    /** The hourly canary, or with [kind] "home-off" ([HOME_OFF]): home is shutting down cleanly. Other kinds: a ping. */
    data class Ping(override val id: String, val ts: Long?, val kind: String? = null) : Push {
        val homeOff get() = kind == HOME_OFF
    }

    companion object {
        const val HOME_OFF = "home-off"

        /** @throws IllegalArgumentException for an unknown type, version or shape. */
        fun parse(t: String, plaintext: ByteArray): Push {
            val o = parseObject(String(plaintext, Charsets.UTF_8))
            require(o.long("v") == 1L) { "unsupported version" }
            val id = o.str("id")?.takeIf { it.isNotBlank() } ?: throw IllegalArgumentException("no id")
            return when (t) {
                "m" -> ItemPush(Item.parse(o) ?: throw IllegalArgumentException("bad item"))
                "c" -> Close(id, o.strings("close"))
                "p" -> Ping(id, o.long("ts"), o.str("kind"))
                else -> throw IllegalArgumentException("unknown type")
            }
        }
    }
}

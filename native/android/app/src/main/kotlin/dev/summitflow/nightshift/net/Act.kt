package dev.summitflow.nightshift.net

import android.content.Context
import dev.summitflow.nightshift.data.Store
import dev.summitflow.nightshift.model.Item
import dev.summitflow.nightshift.model.bool
import dev.summitflow.nightshift.model.str
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** A button without a link: ask the server to do it, show what it says. */
object Act {
    /** [openUrl]: a page the answer points to (the approval card, or a link to open instead); the caller opens it. */
    data class Answer(val ok: Boolean, val text: String, val openUrl: String? = null)

    data class Route(val path: String, val body: JsonObject)

    /**
     * Where a press goes: the item's act route when the row names its item, else the older /api/app/act with the row
     * id (a row no item holds yet, or a push the list hasn't shown).
     */
    fun route(rowId: String, itemId: String?, action: String): Route =
        if (!itemId.isNullOrBlank()) Route("/api/app/items/${pathSegment(itemId)}/act", buildJsonObject { put("action", action) })
        else Route("/api/app/act", buildJsonObject { put("row", rowId); put("action", action) })

    /** The server's answer in the app's words. */
    fun read(r: ApiResult): Answer = when (r) {
        is ApiResult.Ok -> {
            val url = r.json.str("approve_url") ?: r.json.str("url")
            val ok = r.json.bool("ok") != false || url != null
            Answer(ok, r.json.str("text") ?: r.json.str("error") ?: if (ok) "Done." else "Not done.", url?.takeIf { it.isNotBlank() })
        }
        is ApiResult.Err -> Answer(false, if (r.code == 409) (r.json?.str("error") ?: "No longer open.") else r.message)
    }

    /** Blocking. [item] is a row or a pushed item, [action] one of its action ids. */
    fun run(ctx: Context, item: Item, action: String): Answer {
        val store = Store.get(ctx)
        val cfg = store.config() ?: return Answer(false, "This phone isn't paired.")
        val itemId = item.itemId ?: store.snapshot()?.itemIdFor(item.rowId)
        val api = ApiClient(cfg)
        val first = route(item.rowId, itemId, action)
        val r = api.post(first.path, first.body)
        // A home from before the item route answers its router's plain 404: the older route still acts.
        if (itemId != null && r is ApiResult.Err && r.code == 404 && r.json?.str("error") == "not found") {
            val old = route(item.rowId, null, action)
            return read(api.post(old.path, old.body))
        }
        return read(r)
    }

    /** Percent-encodes everything outside RFC 3986's unreserved characters. */
    fun pathSegment(s: String): String = buildString {
        for (b in s.toByteArray(Charsets.UTF_8)) {
            val c = b.toInt() and 0xff
            if (c in 'A'.code..'Z'.code || c in 'a'.code..'z'.code || c in '0'.code..'9'.code || c.toChar() in "-._~") append(c.toChar())
            else append('%').append("%02X".format(c))
        }
    }
}

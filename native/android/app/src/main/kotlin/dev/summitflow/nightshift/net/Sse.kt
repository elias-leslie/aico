package dev.summitflow.nightshift.net

/** One Server-Sent Event. [id] is the last event id seen so far on this stream (it carries over, as in browsers). */
data class SseEvent(val type: String, val data: String, val id: String?)

/**
 * Line-at-a-time SSE parser (the WHATWG event-stream rules the website's EventSource follows). Feed it lines without
 * their line ending; a blank line ends an event. Comments (`: keepalive`) and `retry:` produce nothing.
 */
class SseParser(lastEventId: String? = null) {
    var lastEventId: String? = lastEventId
        private set
    /** The server's `retry:` in ms, when it sent one. */
    var retryMs: Long? = null
        private set

    private var type = ""
    private val data = StringBuilder()
    private var hasData = false

    fun feed(line: String): SseEvent? {
        if (line.isEmpty()) return dispatch()
        if (line.startsWith(":")) return null
        val colon = line.indexOf(':')
        val field = if (colon < 0) line else line.substring(0, colon)
        var value = if (colon < 0) "" else line.substring(colon + 1)
        if (value.startsWith(" ")) value = value.substring(1)
        when (field) {
            "event" -> type = value
            "data" -> { if (hasData) data.append('\n'); data.append(value); hasData = true }
            "id" -> if ('\u0000' !in value) lastEventId = value
            "retry" -> value.takeIf { it.isNotEmpty() && it.all(Char::isDigit) }?.toLongOrNull()?.let { retryMs = it }
        }
        return null
    }

    private fun dispatch(): SseEvent? {
        val ev = if (hasData) SseEvent(type.ifEmpty { "message" }, data.toString(), lastEventId) else null
        type = ""; data.setLength(0); hasData = false
        return ev
    }
}

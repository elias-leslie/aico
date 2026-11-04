package dev.summitflow.nightshift.net

import java.io.InterruptedIOException
import java.net.SocketTimeoutException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** What the live feed is doing, for the screen's header line. Times are epoch seconds. */
sealed interface LiveState {
    /** Not wanted: the lists aren't showing (background, Status, Settings) or the phone isn't paired. */
    data object Off : LiveState
    /** First connect since the lists came up; nothing heard yet. */
    data object Connecting : LiveState
    data class Live(val since: Long) : LiveState
    /** No live feed since [since] (the list may be behind); [why] is the latest failure. Retrying on its own. */
    data class Down(val since: Long, val why: String) : LiveState
}

/** An open event stream. [cancel] may be called from any thread and makes a blocked [readLine] throw. */
interface StreamConn {
    /** The next line without its ending; null at the end of the stream. */
    fun readLine(): String?
    fun cancel()
    fun close()
}

sealed interface StreamOpen {
    data class Ok(val conn: StreamConn) : StreamOpen
    /** [code] 0: no answer at all. */
    data class Failed(val code: Int, val why: String) : StreamOpen
}

/** Reconnect delays: the server's `retry:` (3 s) doubling per failure up to [capMs]; reset once a stream reads. */
class Backoff(var baseMs: Long = 3_000, private val capMs: Long = 60_000) {
    private var fails = 0

    fun next(): Long {
        val d = (baseMs shl fails.coerceAtMost(16)).coerceAtMost(capMs)
        fails++
        return d
    }

    fun reset() { fails = 0 }
}

/**
 * Holds one /api/app/stream connection while [run] runs, reconnecting with [Backoff] until [stop]. Every event goes
 * to [onEvent]; the caller re-reads the list. The only silence limit is the stream's: no byte at all for
 * [DEAD_AFTER_SEC] (the server sends a keepalive every 15 s) means the connection is dead. [open] applies it
 * (ApiClient.openStream's read timeout) and throws [SocketTimeoutException] from readLine when it trips.
 */
class LiveFeed(
    private val open: (lastEventId: String?) -> StreamOpen,
    private val onEvent: (SseEvent) -> Unit,
    private val onState: (LiveState) -> Unit,
    lastEventId: String? = null,
    private val clock: () -> Long = { System.currentTimeMillis() / 1000 },
    private val backoff: Backoff = Backoff(),
    /** Waits [ms] or until [stop]; the default wakes on stop. */
    private val pause: ((Long) -> Unit)? = null,
) {
    @Volatile private var stopped = false
    @Volatile private var conn: StreamConn? = null
    private val stopping = CountDownLatch(1)

    /** Where a reconnect resumes (sent as Last-Event-ID). */
    @Volatile var lastEventId: String? = lastEventId
        private set

    /** Blocking: connects, reads and reconnects until [stop]. */
    fun run() {
        var downSince: Long? = null
        onState(LiveState.Connecting)
        while (!stopped) {
            val why = once { downSince = null }
            if (stopped) break
            val since = downSince ?: clock().also { downSince = it }
            onState(LiveState.Down(since, why))
            sleepBeforeRetry(backoff.next())
        }
    }

    /** One connection, to its end. [onLive] runs when its first event arrives. Returns why it ended. */
    private fun once(onLive: () -> Unit): String {
        val c = when (val o = open(lastEventId)) {
            is StreamOpen.Failed -> return o.why
            is StreamOpen.Ok -> o.conn
        }
        conn = c
        if (stopped) { c.cancel(); c.close(); conn = null; return "Stopped." }
        val parser = SseParser(lastEventId)
        var live = false
        return try {
            var line = c.readLine()
            while (line != null) {
                val ev = parser.feed(line)
                parser.retryMs?.let { backoff.baseMs = it.coerceAtLeast(1_000) }
                if (ev != null) {
                    lastEventId = parser.lastEventId
                    if (!live) {
                        live = true
                        backoff.reset()
                        onLive()
                        onState(LiveState.Live(clock()))
                    }
                    onEvent(ev)
                }
                line = c.readLine()
            }
            "Home closed the live feed."
        } catch (e: SocketTimeoutException) {
            "Nothing from home for ${DEAD_AFTER_SEC / 60} minutes."
        } catch (e: InterruptedIOException) {
            "Stopped."
        } catch (e: Exception) { // IOException mostly; nothing here may end the app
            "Connection lost (${e.javaClass.simpleName})."
        } finally {
            conn = null
            c.close()
        }
    }

    private fun sleepBeforeRetry(ms: Long) {
        pause?.let { it(ms); return }
        stopping.await(ms, TimeUnit.MILLISECONDS)
    }

    /** Any thread: drops the connection and ends [run] without calling [onState] again. */
    fun stop() {
        stopped = true
        conn?.cancel()
        stopping.countDown()
    }

    companion object {
        /** Zero bytes this long (keepalives every 15 s) is a dead connection: the one silence limit (owner rule). */
        const val DEAD_AFTER_SEC = 300L

        /** Events after which the list on screen is re-read. */
        val REFRESH_ON = setOf("hello", "item", "reset", "health")
    }
}

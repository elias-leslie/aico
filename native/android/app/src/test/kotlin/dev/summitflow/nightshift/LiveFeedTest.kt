package dev.summitflow.nightshift

import dev.summitflow.nightshift.net.Backoff
import dev.summitflow.nightshift.net.LiveFeed
import dev.summitflow.nightshift.net.LiveState
import dev.summitflow.nightshift.net.SseEvent
import dev.summitflow.nightshift.net.SseParser
import dev.summitflow.nightshift.net.StreamConn
import dev.summitflow.nightshift.net.StreamOpen
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.net.SocketTimeoutException

class LiveFeedTest {
    private fun parse(text: String, p: SseParser = SseParser()): List<SseEvent> = text.split("\n").mapNotNull(p::feed)

    // --- the parser, on what web/stream.py writes ---

    @Test fun serverFramesParse() {
        val p = SseParser()
        val evs = parse(
            "retry: 3000\n\n" +
                "id: 41\nevent: hello\ndata: {\"rev\":41}\n\n" +
                ": keepalive\n\n" +
                "event: item\ndata: {\"id\":\"a\",\"rev\":42,\"state\":\"open\"}\n\n" +
                "id: 42\nevent: item\ndata: {\"id\":\"b\",\"rev\":42,\"state\":null}\n\n",
            p,
        )
        assertEquals(listOf("hello", "item", "item"), evs.map { it.type })
        assertEquals("{\"rev\":41}", evs[0].data)
        // An event without its own id keeps the last one (the server ids only a batch's last event).
        assertEquals(listOf("41", "41", "42"), evs.map { it.id })
        assertEquals("42", p.lastEventId)
        assertEquals(3000L, p.retryMs)
    }

    @Test fun parserFollowsTheEventStreamRules() {
        val evs = parse("data:one\ndata: two\n\nevent: x\n\ndata\n\n:only a comment\n\nid: bad\u0000id\ndata: z\n\n", SseParser("7"))
        assertEquals(SseEvent("message", "one\ntwo", "7"), evs[0])
        // event with no data dispatches nothing; a bare "data" line is an empty data line
        assertEquals(SseEvent("message", "", "7"), evs[1])
        // an id with NUL is ignored
        assertEquals(SseEvent("message", "z", "7"), evs[2])
        assertEquals(3, evs.size)
        assertNull(SseParser().feed(""))
    }

    // --- backoff ---

    @Test fun backoffDoublesToItsCapAndResets() {
        val b = Backoff(baseMs = 3_000, capMs = 60_000)
        assertEquals(listOf(3_000L, 6_000L, 12_000L, 24_000L, 48_000L, 60_000L, 60_000L), List(7) { b.next() })
        b.reset()
        assertEquals(3_000L, b.next())
        repeat(100) { b.next() }
        assertEquals(60_000L, b.next())
    }

    // --- the reconnect loop ---

    private class FakeConn(lines: List<String>, private val end: Exception? = null) : StreamConn {
        private val it = lines.iterator()
        var closed = false
        override fun readLine(): String? = if (it.hasNext()) it.next() else end?.let { throw it }
        override fun cancel() {}
        override fun close() { closed = true }
    }

    private class Harness(vararg opens: () -> StreamOpen) {
        val queue = ArrayDeque(opens.toList())
        val asked = mutableListOf<String?>()
        val events = mutableListOf<String>()
        val states = mutableListOf<LiveState>()
        val waits = mutableListOf<Long>()
        var now = 1000L
        lateinit var feed: LiveFeed

        fun run(lastEventId: String? = null): Harness {
            feed = LiveFeed(
                // past the scripted answers: the screen went away
                open = { id -> asked += id; queue.removeFirstOrNull()?.invoke() ?: StreamOpen.Failed(0, "gone").also { feed.stop() } },
                onEvent = { events += it.type },
                onState = { states += it },
                lastEventId = lastEventId,
                clock = { now },
                pause = { ms -> waits += ms; now += ms / 1000 },
            )
            feed.run()
            return this
        }
    }

    private fun lines(vararg frames: String) = frames.joinToString("\n\n", postfix = "\n\n").split("\n").dropLast(1)

    @Test fun reconnectsWithLastEventIdAndBacksOff() {
        val first = FakeConn(lines("retry: 3000", "id: 5\nevent: hello\ndata: {}", "id: 6\nevent: item\ndata: {}"))
        val h = Harness(
            { StreamOpen.Ok(first) },
            { StreamOpen.Failed(0, "No answer: UnknownHostException") },
            { StreamOpen.Failed(503, "too many open streams") },
            { StreamOpen.Ok(FakeConn(lines("id: 9\nevent: reset\ndata: {}"))) },
        ).run(lastEventId = "4")
        assertEquals(listOf("4", "6", "6", "6", "9"), h.asked)
        assertEquals(listOf("hello", "item", "reset"), h.events)
        assertTrue(first.closed)
        // Connecting, Live, then down from the first failure on (its since kept across retries), Live again.
        assertEquals(LiveState.Connecting, h.states[0])
        assertEquals(LiveState.Live(1000), h.states[1])
        assertEquals(LiveState.Down(1000, "Home closed the live feed."), h.states[2])
        assertEquals(LiveState.Down(1000, "No answer: UnknownHostException"), h.states[3])
        assertEquals(LiveState.Down(1000, "too many open streams"), h.states[4])
        assertEquals(LiveState.Live(1021), h.states[5])
        assertEquals(LiveState.Down(1021, "Home closed the live feed."), h.states[6])
        assertEquals(7, h.states.size)
        // A stream that read resets the backoff; failures in a row double it.
        assertEquals(listOf(3_000L, 6_000L, 12_000L, 3_000L), h.waits)
        assertEquals("9", h.feed.lastEventId)
    }

    @Test fun silenceTimeoutIsADeadConnection() {
        val h = Harness(
            { StreamOpen.Ok(FakeConn(lines("id: 1\nevent: hello\ndata: {}", ": keepalive"), SocketTimeoutException("timeout"))) },
            { StreamOpen.Ok(FakeConn(lines("id: 2\nevent: hello\ndata: {}"), IOException("reset"))) },
        ).run()
        assertEquals(LiveState.Down(1000, "Nothing from home for 5 minutes."), h.states[2])
        assertEquals(LiveState.Down(1003, "Connection lost (IOException)."), h.states[4])
        assertEquals(listOf(null, "1", "2"), h.asked)
        assertEquals(300L, LiveFeed.DEAD_AFTER_SEC)
    }

    @Test fun stopEndsTheLoopWithoutAnotherState() {
        var feed: LiveFeed? = null
        val states = mutableListOf<LiveState>()
        val conn = object : StreamConn {
            val ls = listOf("id: 1", "event: hello", "data: {}", "")
            var n = 0
            override fun readLine(): String? {
                if (n == ls.size) { feed!!.stop(); throw IOException("Canceled") }
                return ls[n++]
            }
            override fun cancel() {}
            override fun close() {}
        }
        feed = LiveFeed(open = { StreamOpen.Ok(conn) }, onEvent = {}, onState = { states += it }, pause = { error("no wait after stop") })
        feed.run()
        assertEquals(2, states.size)
        assertEquals(LiveState.Connecting, states[0])
        assertTrue(states[1] is LiveState.Live)
    }

    @Test fun refreshFollowsListChangingEvents() {
        assertTrue(listOf("hello", "item", "reset", "health").all { it in LiveFeed.REFRESH_ON })
        assertTrue("message" !in LiveFeed.REFRESH_ON)
    }
}

package dev.summitflow.nightshift

import com.sun.net.httpserver.HttpServer
import dev.summitflow.nightshift.alarm.HomeCause
import dev.summitflow.nightshift.alarm.HomeProbe
import dev.summitflow.nightshift.alarm.OutageAlarm
import dev.summitflow.nightshift.alarm.OutageEffect
import dev.summitflow.nightshift.alarm.OutageRule
import dev.summitflow.nightshift.data.Config
import dev.summitflow.nightshift.data.ProbeLog
import dev.summitflow.nightshift.data.Store
import dev.summitflow.nightshift.model.FcmConfig
import dev.summitflow.nightshift.net.ApiClient
import dev.summitflow.nightshift.net.ApiResult
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/** The planned-off mark through the store: rounds as OutageAlarm runs them, a home-off as the push service takes it. */
class PlannedOffStoreTest {
    @get:Rule val tmp = TemporaryFolder()

    private val ok = HomeProbe(null, true, null, "ok")
    private val down = HomeProbe(HomeCause.Unreachable, false, null, "No answer")

    @Test fun anOldHomeOffAfterManyFailedRoundsIsIgnoredAndTheOutageAlarms() {
        val store = Store(tmp.newFolder())
        assertEquals(OutageEffect.None, OutageAlarm.round(store, ok.copy(serverNow = 1_000), true, 1_005))
        assertEquals(1_000L, store.lastAnsweredAt()) // home's clock
        // home goes down for real while the phone is offline: eight rounds, no alarm, the count kept
        var t = 1_005L
        repeat(8) { t += 900; assertEquals(OutageEffect.None, OutageAlarm.round(store, down, false, t)) }
        assertTrue(store.probes().none { it.homeOk }) // the log forgot the good round...
        assertEquals(1_000L, store.lastAnsweredAt()) // ...the last answer is kept

        // the phone reconnects and a home-off sent before home last answered arrives, hours late
        store.homeOff(900)
        assertNull(store.plannedOff())
        t += 900; assertEquals(OutageEffect.None, OutageAlarm.round(store, down, true, t))
        assertEquals(OutageEffect.Raise(t, HomeCause.Unreachable), OutageAlarm.round(store, down, true, t + 900))
    }

    @Test fun aHomeOffSentAfterTheLastAnswerHoldsTheAlarm() {
        val store = Store(tmp.newFolder())
        OutageAlarm.round(store, ok.copy(serverNow = 1_000), true, 1_000)
        store.homeOff(2_000)
        assertEquals(2_000L, store.plannedOff())
        var t = 2_000L
        repeat(10) { t += 900; assertEquals(OutageEffect.None, OutageAlarm.round(store, down, true, t)) }
        // home is back but its health fails: the mark ends, the normal rule alarms on the next round
        val failing = HomeProbe(HomeCause.Unreachable, true, null, "answered 503")
        assertEquals(OutageEffect.None, OutageAlarm.round(store, failing, true, t + 900))
        assertNull(store.plannedOff())
        assertEquals(OutageEffect.Raise(t + 900, HomeCause.Unreachable), OutageAlarm.round(store, failing, true, t + 1_800))
        assertEquals(t + 1_800, store.lastAnsweredAt()) // an error answer is still an answer (phone's clock without one)
    }

    @Test fun storesFromBeforeTheKeptValueFallBackToTheNewestGoodProbe() {
        val dir = tmp.newFolder()
        java.io.File(dir, "outage.json").writeText(
            """{"fails":0,"first_fail_at":0,"alarmed":false,"probes":[{"at":500,"home_ok":true,"home_note":"ok","public_ok":true}]}""",
        )
        assertEquals(500L, Store(dir).lastAnsweredAt())
    }

    // --- through the real ApiClient: what an HTTP answer turns into ---

    private var server: HttpServer? = null

    private var raw: ServerSocket? = null

    @After fun stop() { server?.stop(0); server = null; raw?.close(); raw = null }

    /**
     * A raw stand-in for home that sends 200 headers promising 1000 bytes, then 10 bytes of body, then [after]:
     * hang up (a body cut short) or stall (sleep past the call timeout).
     */
    private fun brokenHome(stall: Boolean): ApiClient {
        val srv = ServerSocket(0, 0, java.net.InetAddress.getByName("127.0.0.1"))
        raw = srv
        thread(isDaemon = true) {
            while (!srv.isClosed) {
                val sock = try { srv.accept() } catch (e: Exception) { break }
                thread(isDaemon = true) {
                    sock.use { c ->
                        val inp = c.getInputStream().bufferedReader()
                        while (inp.readLine()?.isNotEmpty() == true) Unit // the request head
                        val date = DateTimeFormatter.RFC_1123_DATE_TIME.format(ZonedDateTime.now(java.time.ZoneOffset.UTC))
                        val out = c.getOutputStream()
                        out.write("HTTP/1.1 200 OK\r\nDate: $date\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{\"ok\":true".toByteArray())
                        out.flush()
                        if (stall) try { Thread.sleep(5_000) } catch (e: InterruptedException) { Unit }
                    }
                }
            }
        }
        return client("http://127.0.0.1:${srv.localPort}")
    }

    /** A local stand-in for home's health that answers [status] with [body] ([body] null: no body). */
    private fun home(status: Int, body: String?, type: String = "application/json"): ApiClient {
        val srv = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        srv.createContext("/api/app/health") { ex ->
            val bytes = body?.toByteArray()
            ex.responseHeaders.add("Content-Type", type)
            ex.sendResponseHeaders(status, if (bytes == null) -1 else bytes.size.toLong())
            bytes?.let { ex.responseBody.write(it) }
            ex.close()
        }
        srv.start()
        server = srv
        return client("http://127.0.0.1:${srv.address.port}")
    }

    private fun client(base: String) = ApiClient(
        Config(base, "cid", "csec", emptyList(), "", FcmConfig("p", "a", "k", "s"), "dev", "phone", "au", "enc", "sig",
            null, false),
        sign = { ByteArray(64) }, clock = { 1_000 },
    )

    private fun httpDate() = DateTimeFormatter.RFC_1123_DATE_TIME.format(ZonedDateTime.now(java.time.ZoneOffset.UTC))

    /**
     * A raw stand-in for home that answers each request, on any connection, with the next of [replies]: a status line
     * and headers (a Date is added, the head is ended; no body), or null to stall past any call timeout. The count of
     * requests it saw is [hits].
     */
    private val hits = AtomicInteger()

    private fun scripted(vararg replies: String?): ApiClient {
        val srv = ServerSocket(0, 0, java.net.InetAddress.getByName("127.0.0.1"))
        raw = srv
        hits.set(0)
        thread(isDaemon = true) {
            while (!srv.isClosed) {
                val sock = try { srv.accept() } catch (e: Exception) { break }
                thread(isDaemon = true) {
                    sock.use { c ->
                        val inp = c.getInputStream().bufferedReader()
                        while (true) {
                            if (inp.readLine() == null) break
                            while (inp.readLine()?.isNotEmpty() == true) Unit // the rest of the request head
                            val reply = replies.getOrNull(hits.getAndIncrement())
                            if (reply == null) { try { Thread.sleep(5_000) } catch (e: InterruptedException) { Unit }; break }
                            c.getOutputStream().apply { write("$reply\r\nDate: ${httpDate()}\r\n\r\n".toByteArray()); flush() }
                        }
                    }
                }
            }
        }
        return client("http://127.0.0.1:${srv.localPort}")
    }

    @Test fun an200ThatIsntHealthJsonIsStillHomeAnswering() {
        val p = OutageAlarm.probeHome(home(200, "<html>Bad gateway page</html>", "text/html"), 5_000)
        assertEquals(HomeCause.Unreachable, p.cause) // not good: the normal rule alarms on it
        assertTrue(p.answered)
        assertNotNull(p.serverNow) // the Date header, the answering side's clock
    }

    @Test fun anEmpty204IsStillHomeAnswering() {
        val p = OutageAlarm.probeHome(home(204, null), 5_000)
        assertEquals(HomeCause.Unreachable, p.cause)
        assertTrue(p.answered)
    }

    @Test fun healthJsonAndErrorStatusesAndTheEdgesOwn530() {
        val now = System.currentTimeMillis() / 1000
        val good = OutageAlarm.probeHome(home(200, """{"ok":true,"now":$now,"checked_at":$now}"""), now)
        assertNull(good.cause); assertTrue(good.answered); assertEquals(now, good.serverNow)
        stop()
        assertTrue(OutageAlarm.probeHome(home(503, """{"error":"down"}"""), now).answered)
        stop()
        assertTrue(OutageAlarm.probeHome(home(401, "{}"), now).answered)
        stop()
        val edge = OutageAlarm.probeHome(home(530, "error code: 1033", "text/plain"), now)
        assertEquals(HomeCause.Unreachable, edge.cause); assertFalse(edge.answered)
        val port = server!!.address.port
        stop() // nothing listens there now
        assertFalse(OutageAlarm.probeHome(client("http://127.0.0.1:$port"), now).answered)
    }

    @Test fun homeServingHtmlAfterAPlannedOffEndsTheMarkAndAlarms() {
        val store = Store(tmp.newFolder())
        store.homeOff(1_000)
        val html = OutageAlarm.probeHome(home(200, "<html></html>", "text/html"))
        assertEquals(OutageEffect.None, OutageAlarm.round(store, html, true, html.serverNow!!))
        assertNull(store.plannedOff())
        assertEquals(OutageEffect.Raise(html.serverNow!!, HomeCause.Unreachable), OutageAlarm.round(store, html, true, html.serverNow!! + 900))
    }

    // --- a home-off arriving while a round is being saved ---

    @Test fun aHomeOffDuringARoundIsJudgedAgainstThatRoundsAnswer() {
        val store = Store(tmp.newFolder())
        OutageAlarm.round(store, ok.copy(serverNow = 100), true, 100)
        val inRule = CountDownLatch(1)
        lateinit var push: Thread
        // the probe at 300 answered; while its round runs, the push service takes a home-off sent at 200
        val effect = store.recordRound(ProbeLog(300, true, "ok", true), 300) { s, planned ->
            push = thread { inRule.await(); store.homeOff(200) }
            inRule.countDown()
            push.join(300) // it waits for the round's lock
            assertTrue(push.isAlive)
            OutageRule.step(s, true, true, 300, plannedOff = planned)
        }
        push.join(5_000)
        assertEquals(OutageEffect.None, effect)
        assertEquals(300L, store.lastAnsweredAt())
        assertNull(store.plannedOff()) // sent before the answer at 300: ignored
        // home then stops answering: the outage alarm comes
        assertEquals(OutageEffect.None, OutageAlarm.round(store, down, true, 1_200))
        assertEquals(OutageEffect.Raise(1_200, HomeCause.Unreachable), OutageAlarm.round(store, down, true, 2_100))
    }

    @Test fun aMarkThatLandedBeforeTheRoundSavedIsDroppedByTheAnswer() {
        val store = Store(tmp.newFolder())
        OutageAlarm.round(store, ok.copy(serverNow = 100), true, 100)
        store.homeOff(200) // accepted: home last answered at 100
        assertEquals(200L, store.plannedOff())
        OutageAlarm.round(store, ok.copy(serverNow = 300), true, 300) // the answer at 300 is newer: the mark goes
        assertNull(store.plannedOff())
        assertEquals(OutageEffect.None, OutageAlarm.round(store, down, true, 1_200))
        assertEquals(OutageEffect.Raise(1_200, HomeCause.Unreachable), OutageAlarm.round(store, down, true, 2_100))
    }

    @Test fun aMarkNewerThanTheAnswerStays() {
        val store = Store(tmp.newFolder())
        store.homeOff(400) // home went off at 400, after answering at 300
        OutageAlarm.round(store, ok.copy(serverNow = 300), true, 300)
        assertEquals(400L, store.plannedOff())
        repeat(5) { assertEquals(OutageEffect.None, OutageAlarm.round(store, down, true, 1_200L + it * 900)) }
    }

    // --- headers in, body lost: still home answering ---

    private fun bodyLostAfterHeadersEndsThePlannedOff(stall: Boolean) = answerEndsThePlannedOff(brokenHome(stall))

    /** Planned off and held through three silent rounds; then [api]'s probe must count as home answering. */
    private fun answerEndsThePlannedOff(api: ApiClient) {
        val store = Store(tmp.newFolder())
        OutageAlarm.round(store, ok.copy(serverNow = 100), true, 100)
        store.homeOff(200)
        val now = System.currentTimeMillis() / 1000
        repeat(3) { assertEquals(OutageEffect.None, OutageAlarm.round(store, down, true, now - 3_000L + it * 900)) }
        assertEquals(200L, store.plannedOff()) // home off: held

        val p = OutageAlarm.probeHome(api, now, timeoutSec = 1)
        assertEquals(HomeCause.Unreachable, p.cause)
        assertTrue(p.answered)
        assertNotNull(p.serverNow)
        assertEquals(OutageEffect.None, OutageAlarm.round(store, p, true, now))
        assertNull(store.plannedOff()) // the answer ended the mark
        // home keeps failing (or stops answering altogether): the normal rule alarms
        assertEquals(OutageEffect.Raise(now, HomeCause.Unreachable), OutageAlarm.round(store, down, true, now + 900))
    }

    @Test fun a200CutShortAfterItsHeadersEndsThePlannedOffAndAlarms() = bodyLostAfterHeadersEndsThePlannedOff(stall = false)

    @Test fun a200WhoseBodyStallsPastTheTimeoutEndsThePlannedOffAndAlarms() = bodyLostAfterHeadersEndsThePlannedOff(stall = true)

    // --- answers OkHttp itself retries past, or fails on after the headers ---

    @Test fun a503RetriedIntoATimeoutEndsThePlannedOffAndAlarms() {
        answerEndsThePlannedOff(scripted("HTTP/1.1 503 Service Unavailable\r\nRetry-After: 0\r\nContent-Length: 0", null))
        assertEquals(2, hits.get()) // OkHttp did retry it
    }

    @Test fun a503RetriedIntoTheEdges530EndsThePlannedOffAndAlarms() {
        answerEndsThePlannedOff(scripted(
            "HTTP/1.1 503 Service Unavailable\r\nRetry-After: 0\r\nContent-Length: 0",
            "HTTP/1.1 530 Origin Unreachable\r\nContent-Length: 0",
        ))
        assertEquals(2, hits.get())
    }

    @Test fun a408RetriedIntoATimeoutEndsThePlannedOffAndAlarms() {
        answerEndsThePlannedOff(scripted("HTTP/1.1 408 Request Timeout\r\nContent-Length: 0", null))
        assertEquals(2, hits.get())
    }

    @Test fun a204WithABodyLengthEndsThePlannedOffAndAlarms() =
        answerEndsThePlannedOff(scripted("HTTP/1.1 204 No Content\r\nContent-Length: 5"))

    @Test fun onlyTheEdgesOwn530StillCountsAsNoAnswer() {
        val p = OutageAlarm.probeHome(scripted("HTTP/1.1 530 Origin Unreachable\r\nContent-Length: 0"), timeoutSec = 1)
        assertFalse(p.answered)
        stop()
        // a 530 OkHttp doesn't retry past, after a 503 it did: the 503 was home
        val q = OutageAlarm.probeHome(scripted("HTTP/1.1 503 x\r\nRetry-After: 0\r\nContent-Length: 0", "HTTP/1.1 530 x\r\nContent-Length: 0"), timeoutSec = 1)
        assertTrue(q.answered)
    }

    @Test fun normalAnswersKeepTheirCodes() {
        val r = scripted("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0").get("/api/app/items", 2)
        assertEquals(503, (r as ApiResult.Err).code) // no Retry-After: not retried, the code as before
        assertEquals(listOf(503), r.answers.map { it.status })
        assertEquals(1, hits.get())
    }

    // --- only the outage probe's own answers end the mark ---

    @Test fun anotherCallHomeAnswersLeavesTheMarkToTheProbe() {
        val store = Store(tmp.newFolder())
        val now = System.currentTimeMillis() / 1000
        OutageAlarm.round(store, ok.copy(serverNow = now - 5_000), true, now - 5_000)
        store.homeOff(now - 4_000)
        // the app acks the home-off, or fetches the list, and home still answers it: that is not the probe
        val r = home(200, "{}").get("/api/app/health", 2)
        assertTrue(r is ApiResult.Ok)
        assertEquals(now - 4_000, store.plannedOff())
        repeat(3) { assertEquals(OutageEffect.None, OutageAlarm.round(store, down, true, now + 900L * (it + 1))) }
    }
}

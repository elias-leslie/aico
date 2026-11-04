package dev.summitflow.nightshift

import com.sun.net.httpserver.HttpServer
import dev.summitflow.nightshift.data.Config
import dev.summitflow.nightshift.model.FcmConfig
import dev.summitflow.nightshift.net.ApiClient
import dev.summitflow.nightshift.net.ApiResult
import kotlinx.serialization.json.buildJsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/** A signed POST is good once at home: the app never resends the same signed bytes, and a 409 is not "pair again". */
class PostRetryTest {
    private var raw: ServerSocket? = null
    private var http: HttpServer? = null

    @After fun stop() { raw?.close(); http?.stop(0) }

    private fun client(port: Int) = ApiClient(
        Config("http://127.0.0.1:$port", "cid", "csec", emptyList(), "", FcmConfig("p", "a", "k", "s"), "dev", "phone",
            "au", "enc", "sig", null, false),
        sign = { ByteArray(64) }, clock = { 1_000 },
    )

    /**
     * Answers the 1st request it sees, drops the 2nd without an answer (the phone's pooled connection went stale
     * under it), answers any later one. [seen] counts the requests.
     */
    private fun flaky(seen: AtomicInteger): Int {
        val srv = ServerSocket(0, 0, InetAddress.getByName("127.0.0.1"))
        raw = srv
        thread(isDaemon = true) {
            while (!srv.isClosed) {
                val sock = try { srv.accept() } catch (e: Exception) { break }
                thread(isDaemon = true) {
                    sock.use { c ->
                        val inp = c.getInputStream().bufferedReader()
                        while (inp.readLine() != null) {
                            var length = 0
                            while (true) {
                                val line = inp.readLine() ?: return@use
                                if (line.isEmpty()) break
                                if (line.startsWith("Content-Length:", ignoreCase = true)) length = line.substring(15).trim().toInt()
                            }
                            repeat(length) { inp.read() }
                            if (seen.incrementAndGet() == 2) return@use
                            c.getOutputStream().apply {
                                write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"ok\":true}".toByteArray())
                                flush()
                            }
                        }
                    }
                }
            }
        }
        return srv.localPort
    }

    @Test fun aPostOnAConnectionThatWentStaleIsNotSentAgainBelowTheCaller() {
        val seen = AtomicInteger()
        val api = client(flaky(seen))
        assertTrue(api.get("/api/app/health") is ApiResult.Ok)
        val r = api.post("/api/app/ack", buildJsonObject { })
        assertTrue(r is ApiResult.Err && r.code == 0)
        assertEquals(2, seen.get()) // the same signed bytes were not resent
    }

    @Test fun aGetOnAConnectionThatWentStaleStillGetsOkHttpsOwnRetry() {
        val seen = AtomicInteger()
        val api = client(flaky(seen))
        assertTrue(api.get("/api/app/health") is ApiResult.Ok)
        assertTrue(api.get("/api/app/health") is ApiResult.Ok)
        assertEquals(3, seen.get())
    }

    @Test fun a409IsHomesOwnWordsNotPairAgain() {
        val srv = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        http = srv
        srv.createContext("/api/app/ack") { ex ->
            val body = """{"error":"request already used; the app signs a new one"}""".toByteArray()
            ex.responseHeaders.add("Content-Type", "application/json")
            ex.sendResponseHeaders(409, body.size.toLong())
            ex.responseBody.write(body)
            ex.close()
        }
        srv.start()
        val r = client(srv.address.port).post("/api/app/ack", buildJsonObject { }) as ApiResult.Err
        assertEquals(409, r.code)
        assertFalse(r.message.contains("pair again"))
        assertEquals("request already used; the app signs a new one", r.message)
    }
}

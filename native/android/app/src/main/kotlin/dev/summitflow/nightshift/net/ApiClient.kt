package dev.summitflow.nightshift.net

import dev.summitflow.nightshift.crypto.B64
import dev.summitflow.nightshift.crypto.DeviceKeys
import dev.summitflow.nightshift.data.Config
import dev.summitflow.nightshift.model.NsJson
import dev.summitflow.nightshift.model.parseObject
import kotlinx.serialization.json.JsonObject
import okhttp3.Call
import okhttp3.EventListener
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.File
import java.io.InputStream
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

sealed interface ApiResult {
    data class Ok(val json: JsonObject) : ApiResult
    /**
     * [code] 0 is no usable answer (offline, timeout, bad reply); [json] is the body when it parsed. [answers] is every
     * HTTP answer the call got, retries and follow-ups included, also when the call itself then failed (a body that
     * broke off, a retry that timed out, a protocol error after the headers).
     */
    data class Err(
        val code: Int, val message: String, val json: JsonObject? = null,
        val answers: List<HttpAnswer> = emptyList(),
    ) : ApiResult
}

/** One HTTP response as it reached the phone: its status and its Date header (epoch s, the answering side's clock). */
data class HttpAnswer(val status: Int, val date: Long?)

/**
 * Notes each response's status line and headers the moment OkHttp has them, below its retries and follow-ups and
 * before the body or any protocol check.
 */
private class Answers : EventListener() {
    val seen = CopyOnWriteArrayList<HttpAnswer>()

    override fun responseHeadersEnd(call: Call, response: Response) {
        seen += HttpAnswer(response.code, response.headers.getDate("Date")?.time?.div(1000))
    }
}

/** Signed calls to the Aico origin through the Cloudflare Access gate. */
class ApiClient(
    private val cfg: Config,
    private val sign: (ByteArray) -> ByteArray = { DeviceKeys.sign(cfg.keySlot, it) },
    private val clock: () -> Long = { System.currentTimeMillis() / 1000 },
) {
    fun get(path: String, timeoutSec: Long = 15): ApiResult = call("GET", path, null, true, timeoutSec)
    fun post(path: String, body: JsonObject, timeoutSec: Long = 15): ApiResult = call("POST", path, body, true, timeoutSec)

    /** Register carries no device header: the server reads the key from the body. */
    fun register(body: JsonObject): ApiResult = call("POST", "/api/app/register", body, false, 20)

    /**
     * Signed GET (same headers as [get]) that streams the body into [dest]. Stops once more than [maxBytes] arrive.
     * Null on success, else why: code 0 no answer, [TOO_BIG] past [maxBytes], else home's HTTP code. [dest] is
     * deleted on any failure.
     */
    fun download(path: String, dest: File, maxBytes: Long, timeoutSec: Long = 300): ApiResult.Err? {
        val rb = signed("GET", path, ByteArray(0), true) ?: return ApiResult.Err(0, SIGN_FAILED)
        val client = BASE.newBuilder().callTimeout(timeoutSec, TimeUnit.SECONDS).build()
        val err = try {
            client.newCall(rb.get().build()).execute().use { r ->
                when {
                    r.isRedirect -> ApiResult.Err(r.code, "The gate turned the request away (access token).")
                    !r.isSuccessful ->
                        ApiResult.Err(r.code, describe(r.code, try { parseObject(r.body?.string().orEmpty()) } catch (e: Exception) { null }))
                    else -> {
                        val body = r.body
                        if (body == null) ApiResult.Err(0, "Home sent an empty answer.")
                        else copyCapped(body.byteStream(), dest, maxBytes)?.let { ApiResult.Err(TOO_BIG, it) }
                    }
                }
            }
        } catch (e: Exception) {
            ApiResult.Err(0, "No answer: ${e.javaClass.simpleName}")
        }
        if (err != null) dest.delete()
        return err
    }

    /**
     * Signed GET of an event stream (/api/app/stream), resuming after [lastEventId]. No overall time limit: the read
     * timeout is the stream's only one (no byte for [LiveFeed.DEAD_AFTER_SEC]: dead).
     */
    fun openStream(path: String, lastEventId: String?): StreamOpen {
        val rb = signed("GET", path, ByteArray(0), true) ?: return StreamOpen.Failed(0, SIGN_FAILED)
        rb.get().header("Accept", "text/event-stream")
        lastEventId?.let { rb.header("Last-Event-ID", it) }
        val call = STREAM.newCall(rb.build())
        val r = try {
            call.execute()
        } catch (e: Exception) {
            return StreamOpen.Failed(0, "No answer: ${e.javaClass.simpleName}")
        }
        val body = r.body
        if (!r.isSuccessful || body == null) {
            val why = when {
                r.isRedirect -> "The gate turned the request away (access token)."
                body == null -> "Home sent an empty answer."
                else -> describe(r.code, try { parseObject(body.string()) } catch (e: Exception) { null })
            }
            r.close()
            return StreamOpen.Failed(r.code, why)
        }
        val src = body.source()
        return StreamOpen.Ok(object : StreamConn {
            override fun readLine(): String? = src.readUtf8Line()
            override fun cancel() = call.cancel()
            override fun close() = r.close()
        })
    }

    private fun copyCapped(input: InputStream, dest: File, maxBytes: Long): String? {
        var written = 0L
        input.use { inp ->
            dest.outputStream().use { out ->
                val buf = ByteArray(64 * 1024)
                var n = inp.read(buf)
                while (n >= 0) {
                    written += n
                    if (written > maxBytes) return "Home sent more than the $maxBytes bytes it promised."
                    out.write(buf, 0, n)
                    n = inp.read(buf)
                }
            }
        }
        return null
    }

    private fun call(method: String, path: String, body: JsonObject?, withDevice: Boolean, timeoutSec: Long): ApiResult {
        val bytes = body?.let { NsJson.encodeToString(JsonObject.serializer(), it).toByteArray(Charsets.UTF_8) } ?: ByteArray(0)
        val rb = signed(method, path, bytes, withDevice) ?: return ApiResult.Err(0, SIGN_FAILED)
        if (method == "POST") rb.post(bytes.toRequestBody(JSON)) else rb.get()
        return exec(rb.build(), timeoutSec)
    }

    /** The gate token and device signature for [method] [path] over [bytes]; null when the key can't sign. */
    private fun signed(method: String, path: String, bytes: ByteArray, withDevice: Boolean): Request.Builder? {
        val ts = clock()
        val sig = try {
            sign(Signing.canonical(method, path, ts, bytes).toByteArray(Charsets.UTF_8))
        } catch (e: Exception) {
            return null
        }
        val rb = Request.Builder().url(cfg.base + path)
            .header("CF-Access-Client-Id", cfg.cid)
            .header("CF-Access-Client-Secret", cfg.csec)
            .header("X-Nightshift-Ts", ts.toString())
            .header("X-Nightshift-Sig", B64.encode(sig))
        if (withDevice) rb.header("X-Nightshift-Device", cfg.deviceId)
        return rb
    }

    private fun exec(req: Request, timeoutSec: Long): ApiResult {
        val answers = Answers()
        // A signed POST is good once at home. OkHttp's silent resend would repeat the same signed bytes
        // (home answers 409 to the copy); a failed POST is left to the caller, which signs a new one.
        val client = BASE.newBuilder().callTimeout(timeoutSec, TimeUnit.SECONDS).eventListener(answers)
            .retryOnConnectionFailure(req.method != "POST").build()
        val result = try {
            client.newCall(req).execute().use { r ->
                val read = try { Result.success(r.body?.string().orEmpty()) } catch (e: Exception) { Result.failure(e) }
                val json = read.getOrNull()?.let { try { parseObject(it) } catch (e: Exception) { null } }
                when {
                    r.isSuccessful && json != null -> ApiResult.Ok(json)
                    r.isSuccessful && read.isFailure -> ApiResult.Err(0, "The answer broke off: ${read.exceptionOrNull()!!.javaClass.simpleName}")
                    r.isSuccessful -> ApiResult.Err(0, "The answer wasn't readable.")
                    r.isRedirect -> ApiResult.Err(r.code, "The gate turned the request away (access token).")
                    else -> ApiResult.Err(r.code, describe(r.code, json), json)
                }
            }
        } catch (e: Exception) {
            ApiResult.Err(0, "No answer: ${e.javaClass.simpleName}")
        }
        // whatever became of the call, the answers it got (Answers notes them below OkHttp's retries) go with it
        return if (result is ApiResult.Err) result.copy(answers = answers.seen.toList()) else result
    }

    private fun describe(code: Int, json: JsonObject?): String {
        val said = (json?.get("error") as? kotlinx.serialization.json.JsonPrimitive)?.content
        return when {
            code == 401 -> "Home doesn't know this phone any more (or the clock is off): pair again."
            code == 409 -> said ?: "Home had that request already; try again."
            code == 403 -> "The gate refused this phone."
            said != null -> said
            else -> "Home answered $code."
        }
    }

    companion object {
        private val JSON = "application/json".toMediaType()
        /** [download]'s code when home sent more than it promised. */
        const val TOO_BIG = -2
        const val SIGN_FAILED = "Couldn't sign the request (the phone's key is missing: pair again)."
        private val BASE: OkHttpClient = OkHttpClient.Builder()
            .followRedirects(false).followSslRedirects(false)
            .connectTimeout(10, TimeUnit.SECONDS).build()
        private val STREAM: OkHttpClient = BASE.newBuilder()
            .readTimeout(LiveFeed.DEAD_AFTER_SEC, TimeUnit.SECONDS).callTimeout(0, TimeUnit.SECONDS).build()

        /** The public reachability probe: plain, no gate token, no signature. 204 means the internet works. */
        fun publicProbe(url: String, timeoutSec: Long): Boolean = try {
            BASE.newBuilder().callTimeout(timeoutSec, TimeUnit.SECONDS).build()
                .newCall(Request.Builder().url(url).get().build()).execute().use { it.code == 204 }
        } catch (e: Exception) { false }
    }
}

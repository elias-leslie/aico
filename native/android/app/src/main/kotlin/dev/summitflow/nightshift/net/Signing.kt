package dev.summitflow.nightshift.net

import dev.summitflow.nightshift.crypto.B64

object Signing {
    /** `METHOD\nPATH\nTS\nb64u(sha256(body))`; PATH includes the query, body is empty for GET. */
    fun canonical(method: String, path: String, ts: Long, body: ByteArray): String =
        method + "\n" + path + "\n" + ts + "\n" + B64.encode(B64.sha256(body))
}

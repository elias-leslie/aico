package dev.summitflow.nightshift.model

import java.net.URI

/** Which links may open in a Custom Tab: https only, origin listed at pairing, nothing else. */
object Origins {
    /** `https://host[:port]` for an https URL with a host and no credentials, else null. */
    fun of(url: String): String? {
        val u = try { URI(url) } catch (e: Exception) { return null }
        if (u.scheme?.lowercase() != "https" || u.rawUserInfo != null) return null
        val host = u.host?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
        val port = if (u.port == -1 || u.port == 443) "" else ":${u.port}"
        return "https://$host$port"
    }

    /** An origin entry itself: no path, query or fragment. */
    fun parseOrigin(entry: String): String? {
        val u = try { URI(entry) } catch (e: Exception) { return null }
        if (!(u.rawPath.isNullOrEmpty() || u.rawPath == "/") || u.rawQuery != null || u.rawFragment != null) return null
        return of(entry)
    }

    /** The origins a pairing named, plus Aico's own, so its alerts and links open whichever host the phone was paired at. */
    fun withAico(stored: List<String>, aico: String): List<String> = (stored + aico).distinctBy { it.lowercase() }

    fun allowed(url: String?, origins: List<String>): Boolean {
        val o = of(url ?: return false) ?: return false
        return origins.any { it.equals(o, ignoreCase = true) }
    }
}

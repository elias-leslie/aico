package dev.summitflow.nightshift.update

import android.content.pm.PackageInstaller
import dev.summitflow.nightshift.model.long
import dev.summitflow.nightshift.model.parseObject
import dev.summitflow.nightshift.model.str
import kotlinx.serialization.json.JsonObject
import java.io.File
import java.security.MessageDigest

/** What `GET /api/app/update` says home has published. [download] is a path on the paired origin. */
data class UpdateManifest(
    val versionCode: Long,
    val versionName: String,
    val sha256: String,
    val size: Long,
    val download: String,
)

class BadManifest(message: String) : Exception(message)

/** The updater's decisions, kept free of Android so they run as plain JVM tests. */
object UpdateRules {
    private val HEX64 = Regex("^[0-9a-f]{64}$")

    fun parse(text: String): UpdateManifest =
        parse(try { parseObject(text) } catch (e: Exception) { throw BadManifest("not a JSON object") })

    /** @throws BadManifest naming the first missing or bad field */
    fun parse(o: JsonObject): UpdateManifest {
        val code = o.long("version_code")?.takeIf { it > 0 } ?: throw BadManifest("version_code is missing or not a positive number")
        val name = o.str("version_name")?.takeIf { it.isNotBlank() } ?: throw BadManifest("version_name is missing")
        val sha = o.str("sha256")?.lowercase()?.takeIf { HEX64.matches(it) } ?: throw BadManifest("sha256 is missing or not 64 hex digits")
        val size = o.long("size")?.takeIf { it > 0 } ?: throw BadManifest("size is missing or not a positive number")
        // Only a path on the paired origin: the device signature and the gate token never go anywhere else.
        val dl = o.str("download")?.takeIf { it.startsWith("/") && !it.startsWith("//") }
            ?: throw BadManifest("download is missing or not a path on home")
        return UpdateManifest(code, name, sha, size, dl)
    }

    fun shouldUpdate(m: UpdateManifest, installedCode: Long): Boolean = m.versionCode > installedCode

    /**
     * Whether to download [m] now. A build Advanced Protection refused ([blockedCode]) is fetched again only when the
     * owner taps Check for update ([manual]); a newer build is tried once on its own.
     */
    fun shouldDownload(m: UpdateManifest, installedCode: Long, blockedCode: Long, manual: Boolean): Boolean =
        shouldUpdate(m, installedCode) && (manual || m.versionCode > blockedCode)

    private val AP_WORDS = Regex("advanced[ _-]?protection", RegexOption.IGNORE_CASE)

    /** What the installer can still answer when Advanced Protection is on: each means the update didn't go in. */
    private val AP_ON_REFUSALS = setOf(
        PackageInstaller.STATUS_FAILURE, PackageInstaller.STATUS_FAILURE_ABORTED, PackageInstaller.STATUS_PENDING_USER_ACTION,
    )

    /**
     * Whether Advanced Protection refused the install. [status] is the installer's answer, null when the session threw
     * before committing; [text] its message or the exception's; [security] the exception was a SecurityException;
     * [apOn] what AdvancedProtectionManager says (null: unknown, below API 36 or not answering). Android lets only
     * Play, adb and preinstalled stores install while it's on, so with [apOn] a refusal or a confirm prompt counts too.
     */
    fun isApBlock(status: Int?, text: String?, security: Boolean, apOn: Boolean?): Boolean =
        status == PackageInstaller.STATUS_FAILURE_BLOCKED ||
            (text != null && AP_WORDS.containsMatchIn(text)) ||
            (apOn == true && (security || status in AP_ON_REFUSALS))

    /** Null when [file] is exactly what [m] promised, else why not. */
    fun verify(file: File, m: UpdateManifest): String? {
        val size = file.length()
        if (size != m.size) return "the download is $size bytes, home said ${m.size}"
        if (sha256Hex(file) != m.sha256) return "the download's sha256 doesn't match what home published"
        return null
    }

    fun sha256Hex(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    // --- what Status says. [Outcome.text] leads, for the owner; [Outcome.detail] is the raw diagnostic under it.

    private const val RETRY = "Tap Check for update to try again."
    private const val UNCHANGED = "Your app is unchanged."
    const val NO_UPDATE = "Home has no update published."
    const val UP_TO_DATE = "Up to date."
    const val WAITING = "Waiting on Android's install prompt. Tap Install if it didn't open."
    const val USB_TITLE = "Update waiting"

    /** On an Advanced Protection phone updates go in over USB from the workstation: the Status line and notice text. */
    fun usbWaiting(name: String) = "Version $name is waiting: plug the phone into the workstation"

    /**
     * Status after Advanced Protection refused an update: not an error. Says whether home has a build newer than the
     * installed one, which the workstation installs over USB. [detail] is Android's raw refusal.
     */
    fun apOutcome(newestCode: Long, newestName: String, installedCode: Long, detail: String) = Outcome(
        if (newestCode > installedCode) usbWaiting(newestName) else UP_TO_DATE, detail, true,
    )

    /** One "Update waiting" notice per refused version, and only while it is newer than the installed build. */
    fun shouldNotifyWaiting(code: Long, installedCode: Long, notifiedCode: Long): Boolean =
        code > installedCode && code != notifiedCode

    /** The raw line for an Advanced Protection refusal: Android's status or exception, and what the AP query said. */
    fun apDetail(status: Int?, message: String?, e: Exception?, apOn: Boolean?): String {
        val base = when {
            e != null -> "(${e.javaClass.simpleName}: ${e.message})"
            status != null -> "Android: ${statusName(status)} ($status)" + (message?.takeIf { it.isNotBlank() }?.let { " $it" } ?: "")
            else -> ""
        }
        val ap = when (apOn) { true -> "Advanced Protection is on"; false -> "Advanced Protection reads off"; null -> "" }
        return listOf(base, ap).filter { it.isNotEmpty() }.joinToString(" · ")
    }

    /** The update notice couldn't be fetched. [code] 0 is no answer; [signFailed] means the phone's key is gone. */
    fun checkFailed(code: Int, message: String, signFailed: Boolean = false): Outcome = when {
        signFailed -> Outcome(message, "", false)
        code == 404 -> Outcome(NO_UPDATE, "", true)
        code == 0 -> Outcome("Couldn't reach home. Check the phone's connection, then tap Check for update.", message, false)
        else -> Outcome("Home answered with an error ($code). $RETRY", message, false)
    }

    /** [tooBig]: home sent more bytes than its notice promised. */
    fun downloadFailed(code: Int, message: String, signFailed: Boolean = false, tooBig: Boolean = false): Outcome = when {
        signFailed -> Outcome(message, "", false)
        tooBig -> mismatch(message)
        code == 0 -> Outcome("Download stopped: couldn't reach home. $RETRY", message, false)
        else -> Outcome("Home answered with an error ($code). $RETRY", message, false)
    }

    /** Wrong size or checksum: nothing reached the installer. */
    fun mismatch(detail: String) =
        Outcome("Update not installed: the file didn't match what home published. $UNCHANGED $RETRY", detail, false)

    fun badNotice(why: String) = Outcome("Home sent a broken update notice. Nothing to do on the phone.", why, false)

    /** Anything else that stopped a check (a bug, a full cache): not the network's fault, so it doesn't say so. */
    fun checkCrashed(e: Exception) =
        Outcome("Couldn't finish the update check. $UNCHANGED $RETRY", "(${e.javaClass.simpleName}: ${e.message})", false)

    fun startFailed(e: Exception) =
        Outcome("Couldn't start the install. $UNCHANGED $RETRY", "(${e.javaClass.simpleName}: ${e.message})", false)

    private fun statusName(status: Int) = when (status) {
        PackageInstaller.STATUS_PENDING_USER_ACTION -> "STATUS_PENDING_USER_ACTION"
        PackageInstaller.STATUS_FAILURE_STORAGE -> "STATUS_FAILURE_STORAGE"
        PackageInstaller.STATUS_FAILURE_TIMEOUT -> "STATUS_FAILURE_TIMEOUT"
        PackageInstaller.STATUS_FAILURE_BLOCKED -> "STATUS_FAILURE_BLOCKED"
        PackageInstaller.STATUS_FAILURE_ABORTED -> "STATUS_FAILURE_ABORTED"
        PackageInstaller.STATUS_FAILURE_INVALID -> "STATUS_FAILURE_INVALID"
        PackageInstaller.STATUS_FAILURE_CONFLICT -> "STATUS_FAILURE_CONFLICT"
        PackageInstaller.STATUS_FAILURE_INCOMPATIBLE -> "STATUS_FAILURE_INCOMPATIBLE"
        PackageInstaller.STATUS_FAILURE -> "STATUS_FAILURE"
        else -> "status"
    }

    /** A PackageInstaller failure: a plain sentence per kind, then Android's status name, code and message. */
    fun installFailed(status: Int, message: String?): Outcome {
        val text = when (status) {
            PackageInstaller.STATUS_FAILURE_STORAGE -> "Not enough free space to install. Free some up, then tap Check for update."
            PackageInstaller.STATUS_FAILURE_TIMEOUT -> "The install timed out. $RETRY"
            PackageInstaller.STATUS_FAILURE_BLOCKED -> "Android blocked the install."
            PackageInstaller.STATUS_FAILURE_ABORTED -> "The install was cancelled."
            PackageInstaller.STATUS_FAILURE_INVALID -> "Android says the update file is invalid."
            PackageInstaller.STATUS_FAILURE_CONFLICT -> "Android says this update conflicts with the installed app."
            PackageInstaller.STATUS_FAILURE_INCOMPATIBLE -> "Android says this update doesn't fit this phone."
            else -> "Android couldn't install the update."
        }
        val msg = message?.takeIf { it.isNotBlank() }?.let { " $it" } ?: ""
        return Outcome(text, "Android: ${statusName(status)} ($status)$msg", false)
    }
}

/** One line for the owner, one raw line for an agent (empty when there is nothing to add), and whether it's fine. */
data class Outcome(val text: String, val detail: String, val ok: Boolean)

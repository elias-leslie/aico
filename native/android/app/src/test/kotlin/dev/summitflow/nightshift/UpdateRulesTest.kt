package dev.summitflow.nightshift

import dev.summitflow.nightshift.update.BadManifest
import dev.summitflow.nightshift.update.Outcome
import dev.summitflow.nightshift.update.UpdateManifest
import dev.summitflow.nightshift.update.UpdateRules
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.security.MessageDigest

class UpdateRulesTest {
    private val sha = "ab".repeat(32)
    private fun json(
        code: String = "3", name: String = "\"0.1.2\"", sha256: String = "\"$sha\"",
        size: String = "3089058", download: String = "\"/api/app/apk\"",
    ) = """{"version_code": $code, "version_name": $name, "sha256": $sha256, "size": $size, "download": $download}"""

    private fun bad(text: String, field: String) {
        try {
            UpdateRules.parse(text)
            fail("parsed: $text")
        } catch (e: BadManifest) {
            assertTrue("${e.message} should name $field", e.message!!.startsWith(field))
        }
    }

    @Test fun validManifestParses() {
        assertEquals(UpdateManifest(3, "0.1.2", sha, 3089058, "/api/app/apk"), UpdateRules.parse(json()))
        // Upper-case hex is the same digest.
        assertEquals(sha, UpdateRules.parse(json(sha256 = "\"${sha.uppercase()}\"")).sha256)
    }

    @Test fun missingOrBadFieldIsRefusedByName() {
        bad("""{"version_name": "0.1.2", "sha256": "$sha", "size": 1, "download": "/api/app/apk"}""", "version_code")
        bad(json(code = "\"3\""), "version_code")
        bad(json(code = "0"), "version_code")
        bad(json(name = "\"\""), "version_name")
        bad(json(sha256 = "\"${sha.dropLast(1)}\""), "sha256")
        bad(json(sha256 = "\"${"zz".repeat(32)}\""), "sha256")
        bad(json(size = "0"), "size")
        bad(json(size = "null"), "size")
        bad(json(download = "\"https://elsewhere.example/apk\""), "download")
        bad(json(download = "\"//elsewhere.example/apk\""), "download")
        bad("[]", "not a JSON object")
    }

    @Test fun sameOrOlderVersionIsNoUpdate() {
        val m = UpdateRules.parse(json(code = "2"))
        assertTrue(UpdateRules.shouldUpdate(m, 1))
        assertFalse(UpdateRules.shouldUpdate(m, 2))
        assertFalse(UpdateRules.shouldUpdate(m, 3))
    }

    private fun apk(bytes: ByteArray): File = File.createTempFile("ns-update", ".apk").apply { deleteOnExit(); writeBytes(bytes) }

    private fun hex(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    private fun manifestFor(size: Long, sha256: String) = UpdateManifest(2, "0.2.0", sha256, size, "/api/app/apk")

    @Test fun matchingDigestPasses() {
        val bytes = ByteArray(200_000) { (it * 31).toByte() } // bigger than one read buffer
        val f = apk(bytes)
        assertEquals(hex(bytes), UpdateRules.sha256Hex(f))
        assertNull(UpdateRules.verify(f, manifestFor(bytes.size.toLong(), hex(bytes))))
    }

    @Test fun mismatchedDigestFails() {
        val bytes = "real apk".toByteArray()
        val f = apk(bytes)
        val why = UpdateRules.verify(f, manifestFor(bytes.size.toLong(), hex("other apk".toByteArray())))
        assertNotNull(why)
        assertTrue(why!!.contains("sha256"))
    }

    @Test fun sizeMismatchFails() {
        val bytes = "real apk".toByteArray()
        val f = apk(bytes)
        assertEquals("the download is 8 bytes, home said 9", UpdateRules.verify(f, manifestFor(9, hex(bytes))))
    }

    @Test fun installerFailureLeadsPlainAndKeepsCodeAndMessage() {
        assertEquals(
            Outcome("Android blocked the install.", "Android: STATUS_FAILURE_BLOCKED (2) Advanced Protection", false),
            UpdateRules.installFailed(2, "Advanced Protection"),
        )
        assertEquals("Not enough free space to install. Free some up, then tap Check for update.", UpdateRules.installFailed(6, null).text)
        assertEquals(Outcome("Android couldn't install the update.", "Android: status (99)", false), UpdateRules.installFailed(99, null))
    }

    @Test fun checkAndDownloadErrorsLeadPlainWithTheRawLineBelow() {
        assertEquals(Outcome(UpdateRules.NO_UPDATE, "", true), UpdateRules.checkFailed(404, "nothing published"))
        assertEquals(
            Outcome("Couldn't reach home. Check the phone's connection, then tap Check for update.", "No answer: SocketTimeoutException", false),
            UpdateRules.checkFailed(0, "No answer: SocketTimeoutException"),
        )
        assertEquals("Home answered with an error (500). Tap Check for update to try again.", UpdateRules.checkFailed(500, "boom").text)
        assertEquals("Download stopped: couldn't reach home. Tap Check for update to try again.", UpdateRules.downloadFailed(0, "x").text)
        // Too many bytes reads as a mismatch; a missing key leads with ApiClient's own words.
        val big = UpdateRules.downloadFailed(-2, "Home sent more than the 9 bytes it promised.", tooBig = true)
        assertTrue(big.text.startsWith("Update not installed: the file didn't match what home published. Your app is unchanged."))
        assertEquals("Home sent more than the 9 bytes it promised.", big.detail)
        assertEquals(Outcome("key gone", "", false), UpdateRules.checkFailed(0, "key gone", signFailed = true))
        assertEquals("version_code is missing", UpdateRules.badNotice("version_code is missing").detail)
    }

    // PackageInstaller statuses, as numbers: the stub jar's constants are what the receiver gets.
    private val pendingUserAction = -1
    private val failure = 1
    private val blocked = 2
    private val aborted = 3
    private val storage = 6

    @Test fun advancedProtectionRefusalIsRecognisedFromEverySignal() {
        // The status alone, or its words in a status message or exception, with or without the AP query.
        assertTrue(UpdateRules.isApBlock(blocked, null, false, null))
        assertTrue(UpdateRules.isApBlock(failure, "Installation restricted by Advanced Protection", false, null))
        assertTrue(UpdateRules.isApBlock(null, "SecurityException: blocked by advanced_protection policy", true, null))
        // With Advanced Protection reported on, a plain refusal, a SecurityException or a confirm prompt counts too.
        assertTrue(UpdateRules.isApBlock(failure, null, false, true))
        assertTrue(UpdateRules.isApBlock(aborted, "", false, true))
        assertTrue(UpdateRules.isApBlock(pendingUserAction, null, false, true))
        assertTrue(UpdateRules.isApBlock(null, "SecurityException: no", true, true))
        // Not Advanced Protection: other failures, or AP unknown/off without its words.
        assertFalse(UpdateRules.isApBlock(storage, "no space", false, true))
        assertFalse(UpdateRules.isApBlock(failure, "INSTALL_FAILED_UPDATE_INCOMPATIBLE", false, null))
        assertFalse(UpdateRules.isApBlock(pendingUserAction, null, false, false))
        assertFalse(UpdateRules.isApBlock(null, "IOException: disk", false, false))
        assertFalse(UpdateRules.isApBlock(null, "SecurityException: no", true, null))
    }

    @Test fun advancedProtectionStatusIsPlainWithTheRawLineBelow() {
        val detail = UpdateRules.apDetail(blocked, "Restricted by Advanced Protection", null, true)
        assertEquals("Android: STATUS_FAILURE_BLOCKED (2) Restricted by Advanced Protection · Advanced Protection is on", detail)
        assertEquals(Outcome("Version 0.2.3 is waiting: plug the phone into the workstation", detail, true), UpdateRules.apOutcome(5, "0.2.3", 4, detail))
        assertEquals(Outcome(UpdateRules.UP_TO_DATE, detail, true), UpdateRules.apOutcome(4, "0.2.2", 4, detail))
        assertEquals("Android: STATUS_PENDING_USER_ACTION (-1)", UpdateRules.apDetail(pendingUserAction, null, null, null))
        assertEquals("(SecurityException: nope) · Advanced Protection is on", UpdateRules.apDetail(null, null, SecurityException("nope"), true))
        assertEquals("Update waiting", UpdateRules.USB_TITLE)
    }

    @Test fun oneWaitingNoticePerRefusedVersion() {
        assertTrue(UpdateRules.shouldNotifyWaiting(code = 5, installedCode = 4, notifiedCode = 0))
        assertFalse(UpdateRules.shouldNotifyWaiting(code = 5, installedCode = 4, notifiedCode = 5))
        assertTrue(UpdateRules.shouldNotifyWaiting(code = 6, installedCode = 4, notifiedCode = 5))
        assertFalse(UpdateRules.shouldNotifyWaiting(code = 5, installedCode = 5, notifiedCode = 0))
    }

    @Test fun aRefusedBuildIsNotDownloadedAgainUntilNewerOrTapped() {
        val m = UpdateRules.parse(json(code = "5"))
        // Nothing refused yet: download.
        assertTrue(UpdateRules.shouldDownload(m, installedCode = 4, blockedCode = 0, manual = false))
        // Build 5 was refused: the daily and on-open checks leave it; the owner's tap retries it.
        assertFalse(UpdateRules.shouldDownload(m, installedCode = 4, blockedCode = 5, manual = false))
        assertTrue(UpdateRules.shouldDownload(m, installedCode = 4, blockedCode = 5, manual = true))
        // A newer build than the refused one is tried once on its own.
        assertTrue(UpdateRules.shouldDownload(m, installedCode = 4, blockedCode = 4, manual = false))
        // Nothing newer than installed: never, tapped or not.
        assertFalse(UpdateRules.shouldDownload(m, installedCode = 5, blockedCode = 0, manual = true))
    }
}

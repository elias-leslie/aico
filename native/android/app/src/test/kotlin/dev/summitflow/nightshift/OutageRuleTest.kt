package dev.summitflow.nightshift

import dev.summitflow.nightshift.alarm.Clock
import dev.summitflow.nightshift.alarm.HomeCause
import dev.summitflow.nightshift.alarm.OutageEffect
import dev.summitflow.nightshift.alarm.OutageRule
import dev.summitflow.nightshift.alarm.OutageState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId
import java.time.ZonedDateTime
import java.util.Locale

class OutageRuleTest {
    @Test fun homeFailsOnErrorNon200OrOldCheck() {
        assertTrue(OutageRule.homeOk(200, 1000, 1000 + 3600, 0))
        assertFalse(OutageRule.homeOk(200, 1000, 1000 + 3601, 0))
        assertFalse(OutageRule.homeOk(null, 1000, 1000, 0))
        assertFalse(OutageRule.homeOk(503, 1000, 1000, 0)) // drill
        assertFalse(OutageRule.homeOk(200, null, 1000, 0)) // never checked
        assertTrue(OutageRule.homeOk(200, 5000, null, 5100)) // no server clock: the phone's
        assertFalse(OutageRule.homeOk(200, 5000, null, 5000 + 3601))
    }

    @Test fun oneFailureOnlyCounts() {
        val (s, e) = OutageRule.step(OutageState(), homeOk = false, publicOk = true, now = 100)
        assertEquals(OutageState(1, 100, false), s)
        assertEquals(OutageEffect.None, e)
    }

    @Test fun secondFailureInARowRaisesOnceWithTheFirstFailureTime() {
        val (s1, _) = OutageRule.step(OutageState(), false, true, 100)
        val (s2, e2) = OutageRule.step(s1, false, true, 1000)
        assertEquals(OutageEffect.Raise(100), e2)
        assertEquals(OutageState(2, 100, true), s2)
        val (s3, e3) = OutageRule.step(s2, false, true, 1900)
        assertEquals(OutageEffect.None, e3) // already raised: no second buzz
        assertEquals(3, s3.fails)
    }

    @Test fun aGoodProbeBetweenFailuresResetsTheCount() {
        val (s1, _) = OutageRule.step(OutageState(), false, true, 100)
        val (s2, e2) = OutageRule.step(s1, true, true, 1000)
        assertEquals(OutageState(), s2)
        assertEquals(OutageEffect.None, e2)
        val (_, e3) = OutageRule.step(s2, false, true, 1900)
        assertEquals(OutageEffect.None, e3)
    }

    @Test fun offlinePhoneNeitherAlarmsNorRecoversAndKeepsTheCount() {
        val one = OutageState(1, 100, false)
        val (s, e) = OutageRule.step(one, false, false, 500)
        assertEquals(one, s)
        assertEquals(OutageEffect.None, e)
        val raised = OutageState(2, 100, true)
        val (s2, e2) = OutageRule.step(raised, true, false, 600)
        assertEquals(raised, s2)
        assertEquals(OutageEffect.None, e2)
    }

    @Test fun recoveryAfterTheAlarmCancelsAndAnnounces() {
        val (s, e) = OutageRule.step(OutageState(2, 100, true), true, true, 2000)
        assertEquals(OutageState(), s)
        assertEquals(OutageEffect.Recover, e)
    }

    @Test fun failureAfterOfflineGapStillReachesTwo() {
        var s = OutageState()
        s = OutageRule.step(s, false, true, 100).first
        s = OutageRule.step(s, false, false, 1000).first // offline round
        val (s3, e3) = OutageRule.step(s, false, true, 1900)
        assertEquals(OutageEffect.Raise(100), e3)
        assertEquals(2, s3.fails)
    }

    // --- a planned power-off (home sent "home-off") ---

    @Test fun plannedOffNeverRaisesAcrossManyFailures() {
        var s = OutageState()
        for (i in 1..40) {
            val (n, e) = OutageRule.step(s, false, true, 100L + i * 900, plannedOff = true)
            assertEquals(OutageEffect.None, e)
            s = n
        }
        assertEquals(40, s.fails)
        assertFalse(s.alarmed)
    }

    @Test fun firstGoodProbeAfterPlannedOffEndsItWithoutAnnouncing() {
        val (s, e) = OutageRule.step(OutageState(12, 100, false), true, true, 20_000, plannedOff = true)
        assertEquals(OutageState(), s)
        assertEquals(OutageEffect.None, e)
    }

    @Test fun anAlarmRaisedBeforeTheMarkArrivedIsClearedQuietly() {
        val (s, e) = OutageRule.step(OutageState(3, 100, true), true, true, 20_000, plannedOff = true)
        assertEquals(OutageState(), s)
        assertEquals(OutageEffect.Clear, e)
    }

    @Test fun homeBackButStuckAfterPlannedOffStillAlarms() {
        val stale = HomeCause.Stale(50)
        val (s1, e1) = OutageRule.step(OutageState(20, 100, false), false, true, 30_000, stale, plannedOff = true)
        assertEquals(OutageState(1, 30_000, false), s1) // a fresh count: the off time isn't held against it
        assertEquals(OutageEffect.None, e1)
        val (_, e2) = OutageRule.step(s1, false, true, 30_900, stale) // mark gone: the normal rule
        assertEquals(OutageEffect.Raise(30_000, stale), e2)
    }

    @Test fun anOfflineRoundWhilePlannedOffKeepsTheCount() {
        val (s, e) = OutageRule.step(OutageState(2, 100, false), true, false, 500, plannedOff = true)
        assertEquals(OutageState(2, 100, false), s)
        assertEquals(OutageEffect.None, e)
    }

    @Test fun anyAnswerPastTheEdgeCountsAsHomeAnswering() {
        for (code in listOf(200, 301, 401, 403, 500, 502, 503, 504)) assertTrue("$code", OutageRule.answered(code))
        for (code in listOf(null, 0, 521, 522, 523, 530)) assertFalse("$code", OutageRule.answered(code))
    }

    /** Home is back but its health answers [code]: the mark ends, and the normal rule alarms on the next failure. */
    private fun errorAnswerWhilePlannedOffAlarms(code: Int) {
        val cause = OutageRule.cause(code, false, null, null, 0)!!
        val answered = OutageRule.answered(code)
        val (s1, e1) = OutageRule.step(OutageState(20, 100, false), false, true, 30_000, cause, plannedOff = true, answered = answered)
        assertEquals(OutageState(1, 30_000, false), s1)
        assertEquals(OutageEffect.None, e1)
        val (_, e2) = OutageRule.step(s1, false, true, 30_900, cause, answered = answered)
        assertEquals(OutageEffect.Raise(30_000, HomeCause.Unreachable), e2) // the words from before 0.2.6
    }

    @Test fun a401WhilePlannedOffEndsItAndAlarms() = errorAnswerWhilePlannedOffAlarms(401)

    @Test fun a503WhilePlannedOffEndsItAndAlarms() = errorAnswerWhilePlannedOffAlarms(503)

    @Test fun a500WhilePlannedOffEndsItAndAlarms() = errorAnswerWhilePlannedOffAlarms(500)

    @Test fun a200WhilePlannedOffEndsItQuietly() {
        val (s, e) = OutageRule.step(OutageState(9, 100, false), true, true, 30_000, plannedOff = true, answered = true)
        assertEquals(OutageState(), s)
        assertEquals(OutageEffect.None, e)
    }

    @Test fun theEdgeSayingTheTunnelIsDownStaysHeld() {
        var s = OutageState()
        for (i in 1..10) {
            val (n, e) = OutageRule.step(
                s, false, true, 100L + i * 900, HomeCause.Unreachable, plannedOff = true, answered = OutageRule.answered(530),
            )
            assertEquals(OutageEffect.None, e)
            s = n
        }
    }

    @Test fun withoutTheMarkNothingChanges() {
        var s = OutageState()
        s = OutageRule.step(s, false, true, 100, plannedOff = false).first
        val (s2, e2) = OutageRule.step(s, false, true, 1000, plannedOff = false)
        assertEquals(OutageEffect.Raise(100), e2)
        assertEquals(OutageEffect.Recover, OutageRule.step(s2, true, true, 2000, plannedOff = false).second)
    }

    @Test fun aHomeOffThatArrivesAfterHomeAnsweredIsIgnored() {
        assertTrue(OutageRule.plannedOffApplies(1000, null))
        assertTrue(OutageRule.plannedOffApplies(1000, 900))
        assertFalse(OutageRule.plannedOffApplies(1000, 1100))
        // same second: the tunnel stops before home-off goes out, so an answer in that second came before the mark
        assertTrue(OutageRule.plannedOffApplies(1000, 1000))
    }

    // --- why home failed, and the alarm's words ---

    @Test fun causeTellsUnreachableStaleAndDrillApart() {
        assertNull(OutageRule.cause(200, false, 1000, 1000 + 3600, 0))
        assertEquals(HomeCause.Stale(1000), OutageRule.cause(200, false, 1000, 1000 + 3601, 0))
        assertEquals(HomeCause.Stale(null), OutageRule.cause(200, false, null, 1000, 0))
        assertEquals(HomeCause.Drill, OutageRule.cause(503, true, null, null, 0))
        assertEquals(HomeCause.Unreachable, OutageRule.cause(503, false, null, null, 0))
        assertEquals(HomeCause.Unreachable, OutageRule.cause(0, false, null, null, 0))
        assertEquals(HomeCause.Unreachable, OutageRule.cause(null, false, null, null, 0))
        assertEquals(HomeCause.Unreachable, OutageRule.cause(502, true, null, null, 0)) // only a 503 is a drill
    }

    @Test fun raiseCarriesTheLatestProbesCause() {
        val (s1, _) = OutageRule.step(OutageState(), false, true, 100, HomeCause.Unreachable)
        val (_, e2) = OutageRule.step(s1, false, true, 1000, HomeCause.Stale(50))
        assertEquals(OutageEffect.Raise(100, HomeCause.Stale(50)), e2)
    }

    private val hhmm: (Long) -> String = { "T$it" }

    @Test fun unreachableKeepsTheOldWords() {
        val (title, body) = OutageRule.alarmText(OutageEffect.Raise(100, HomeCause.Unreachable), hhmm)
        assertEquals("Can't reach home since T100", title)
        assertEquals("Aico at home hasn't answered the last two checks, and the internet here works.", body)
    }

    @Test fun staleSaysHomeIsUpButStoppedChecking() {
        val (title, body) = OutageRule.alarmText(OutageEffect.Raise(100, HomeCause.Stale(42)), hhmm)
        assertEquals("Home is up but stopped checking", title)
        assertEquals(
            "Aico at home answers, but its last check was at T42, over an hour ago. Something on the workstation may be stuck.",
            body,
        )
        val (t2, b2) = OutageRule.alarmText(OutageEffect.Raise(100, HomeCause.Stale(null)), hhmm)
        assertEquals("Home is up but stopped checking", t2)
        assertEquals("Aico at home answers, but has no check on record. Something on the workstation may be stuck.", b2)
    }

    @Test fun drillSaysNothingIsWrong() {
        val (title, body) = OutageRule.alarmText(OutageEffect.Raise(100, HomeCause.Drill), hhmm)
        assertEquals("Can't reach home (outage drill)", title)
        assertEquals("A drill started at home. Nothing is wrong.", body)
    }

    // --- times ---

    @Test fun clockAddsTheWeekdayWhenNotToday() {
        val zone = ZoneId.of("America/New_York")
        val now = ZonedDateTime.of(2026, 10, 31, 9, 0, 0, 0, zone).toEpochSecond() // a Saturday
        val earlierToday = ZonedDateTime.of(2026, 10, 31, 0, 5, 0, 0, zone).toEpochSecond()
        val yesterday = ZonedDateTime.of(2026, 10, 30, 17, 12, 0, 0, zone).toEpochSecond()
        assertEquals("00:05", Clock.short(earlierToday, now, zone, Locale.ENGLISH))
        assertEquals("Fri 17:12", Clock.short(yesterday, now, zone, Locale.ENGLISH))
        // the day is the phone zone's, not UTC's: 21:30 New York on Friday is already Saturday in UTC
        val lateFriday = ZonedDateTime.of(2026, 10, 30, 21, 30, 0, 0, zone).toEpochSecond()
        assertEquals("Fri 21:30", Clock.short(lateFriday, now, zone, Locale.ENGLISH))
        assertEquals("21:30", Clock.short(lateFriday, lateFriday + 60, zone, Locale.ENGLISH))
    }
}

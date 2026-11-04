package dev.summitflow.nightshift.alarm

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.TextStyle
import java.util.Locale

data class OutageState(val fails: Int = 0, val firstFailAt: Long = 0, val alarmed: Boolean = false)

/** Why the home probe failed. */
sealed interface HomeCause {
    /** No answer, or an answer other than 200 (a drill aside). */
    data object Unreachable : HomeCause
    /** Home answered, but its last root check is over 60 min old; [checkedAt] null: no check on record. */
    data class Stale(val checkedAt: Long?) : HomeCause
    /** 503 with `drill`: an outage drill runs at home. */
    data object Drill : HomeCause
}

sealed interface OutageEffect {
    data object None : OutageEffect
    /** Post the local critical; [cause] is the latest probe's, so the text says why. */
    data class Raise(val since: Long, val cause: HomeCause = HomeCause.Unreachable) : OutageEffect
    /** Cancel the critical and post "Home answers again". */
    data object Recover : OutageEffect
    /** Cancel the critical quietly: home was off on purpose and answers again. */
    data object Clear : OutageEffect
}

/** The phone's own outage rule, pure so it can be tested without a clock or a network. */
object OutageRule {
    const val STALE_SECONDS = 3600L
    const val FAILS_TO_ALARM = 2

    /**
     * Statuses Cloudflare's edge sends itself when it can't reach the origin at all: 530 with a 1xxx error (1033: the
     * tunnel has no connector, i.e. the workstation is off) and 521-523 (origin refused, timed out, unreachable).
     * They say nothing about home; every other status was answered past the edge, by home.
     */
    val EDGE_NO_ORIGIN = setOf(521, 522, 523, 530)

    /** Whether home's own side answered: an HTTP status that isn't the edge's "can't reach origin". 0 or null: none. */
    fun answered(status: Int?): Boolean = status != null && status != 0 && status !in EDGE_NO_ORIGIN

    /**
     * Home answers when the probe returned 200 and the last root check is at most 60 min old.
     * [status] null means the probe errored. [checkedAt] null (never checked) counts as failed.
     * Age is judged on the server's clock when it sent `now`, so a drifting phone clock can't fake it.
     */
    fun homeOk(status: Int?, checkedAt: Long?, serverNow: Long?, phoneNow: Long): Boolean =
        cause(status, false, checkedAt, serverNow, phoneNow) == null

    /** Null when home is fine, else why not. [drill] is the 503 body's `drill`. */
    fun cause(status: Int?, drill: Boolean, checkedAt: Long?, serverNow: Long?, phoneNow: Long): HomeCause? {
        if (status == 503 && drill) return HomeCause.Drill
        if (status != 200) return HomeCause.Unreachable
        if (checkedAt == null) return HomeCause.Stale(null)
        return if ((serverNow ?: phoneNow) - checkedAt <= STALE_SECONDS) null else HomeCause.Stale(checkedAt)
    }

    /**
     * One probe round. [plannedOff]: home said it was shutting down cleanly ("home-off" push). Then no answer raises
     * nothing (the count goes on), and the first answer of any kind ([answered]: past Cloudflare's edge) ends it
     * (Store.recordRound drops the mark) without "Home answers again"; an answer that isn't good (an HTTP error, a stale check, a drill)
     * starts a fresh count under the normal rule, so a home that comes back broken or stuck still alarms.
     */
    fun step(
        s: OutageState, homeOk: Boolean, publicOk: Boolean, now: Long,
        cause: HomeCause = HomeCause.Unreachable, plannedOff: Boolean = false,
        answered: Boolean = homeOk || cause != HomeCause.Unreachable,
    ): Pair<OutageState, OutageEffect> {
        if (!publicOk) return s to OutageEffect.None // the phone is offline: no alarm, the count stays
        if (homeOk) {
            val effect = if (!s.alarmed) OutageEffect.None else if (plannedOff) OutageEffect.Clear else OutageEffect.Recover
            return OutageState() to effect
        }
        if (plannedOff) {
            if (answered) return step(OutageState(), false, true, now, cause)
            return OutageState(s.fails + 1, if (s.fails == 0) now else s.firstFailAt, s.alarmed) to OutageEffect.None
        }
        val fails = s.fails + 1
        val first = if (s.fails == 0) now else s.firstFailAt
        if (fails >= FAILS_TO_ALARM && !s.alarmed) {
            return OutageState(fails, first, true) to OutageEffect.Raise(first, cause)
        }
        return OutageState(fails, first, s.alarmed) to OutageEffect.None
    }

    /**
     * Whether a "home-off" sent at [offAt] (home's clock) still applies: not when home answered after it was sent
     * (a message that arrived late, after home came back). [lastHomeOkAt] is the last answer's time, kept on its own
     * (Store.lastAnsweredAt) because the probe log keeps only a few rounds and a home-off may arrive hours late.
     */
    fun plannedOffApplies(offAt: Long, lastHomeOkAt: Long?): Boolean = lastHomeOkAt == null || offAt >= lastHomeOkAt

    /** Title and body of the outage alarm; [clock] formats an epoch second. */
    fun alarmText(r: OutageEffect.Raise, clock: (Long) -> String): Pair<String, String> = when (val c = r.cause) {
        HomeCause.Unreachable -> "Can't reach home since ${clock(r.since)}" to
            "Aico at home hasn't answered the last two checks, and the internet here works."
        is HomeCause.Stale -> "Home is up but stopped checking" to
            (if (c.checkedAt == null) "Aico at home answers, but has no check on record."
            else "Aico at home answers, but its last check was at ${clock(c.checkedAt)}, over an hour ago.") +
            " Something on the workstation may be stuck."
        HomeCause.Drill -> "Can't reach home (outage drill)" to "A drill started at home. Nothing is wrong."
    }
}

/** Short times for the owner: "17:12" today, "Fri 17:12" on any other day. */
object Clock {
    private val HHMM = DateTimeFormatter.ofPattern("HH:mm")

    fun short(epochSec: Long, nowSec: Long, zone: ZoneId, locale: Locale): String {
        val t = Instant.ofEpochSecond(epochSec).atZone(zone)
        val hm = t.format(HHMM)
        if (t.toLocalDate() == Instant.ofEpochSecond(nowSec).atZone(zone).toLocalDate()) return hm
        return t.dayOfWeek.getDisplayName(TextStyle.SHORT, locale) + " " + hm
    }
}

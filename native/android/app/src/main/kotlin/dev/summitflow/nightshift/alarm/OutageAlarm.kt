package dev.summitflow.nightshift.alarm

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import dev.summitflow.nightshift.data.ProbeLog
import dev.summitflow.nightshift.data.Store
import dev.summitflow.nightshift.model.Health
import dev.summitflow.nightshift.net.ApiClient
import dev.summitflow.nightshift.net.ApiResult
import dev.summitflow.nightshift.push.Channels
import dev.summitflow.nightshift.push.Notifier
import java.time.ZoneId
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * One home probe: [cause] null when home is fine; [answered] home's side answered at all (OutageRule.answered);
 * [serverNow] the answering side's clock (health's `now`, else the Date header); [note] goes to the probe log.
 */
data class HomeProbe(val cause: HomeCause?, val answered: Boolean, val serverNow: Long?, val note: String)

/** The phone's own outage alarm: an exact allow-while-idle alarm every 15 minutes. */
object OutageAlarm {
    const val INTERVAL_MIN = 15L
    const val PROBE_TIMEOUT_SEC = 10L
    const val PUBLIC_URL = "https://www.gstatic.com/generate_204"
    const val HOME_QUIET_TAG = "home-quiet"
    const val TEST_TAG = "test-alarm"

    private fun pending(ctx: Context, flags: Int): PendingIntent? =
        PendingIntent.getBroadcast(ctx, 1, Intent(ctx, AlarmReceiver::class.java), flags or PendingIntent.FLAG_IMMUTABLE)

    fun schedule(ctx: Context) {
        val am = ctx.getSystemService(AlarmManager::class.java)
        val at = SystemClock.elapsedRealtime() + INTERVAL_MIN * 60_000
        val pi = pending(ctx, PendingIntent.FLAG_UPDATE_CURRENT)!!
        try {
            am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pi)
        } catch (e: SecurityException) {
            am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pi)
        }
    }

    /** App start: keep an alarm that is already counting down, start one if none is. */
    fun ensureScheduled(ctx: Context) {
        if (Store.get(ctx).config() == null) return
        if (pending(ctx, PendingIntent.FLAG_NO_CREATE) == null) schedule(ctx)
    }

    fun cancel(ctx: Context) {
        val am = ctx.getSystemService(AlarmManager::class.java)
        pending(ctx, PendingIntent.FLAG_NO_CREATE)?.let { am.cancel(it); it.cancel() }
    }

    /** One round: both probes in parallel, the rule, the notification. Blocking. */
    fun runOnce(ctx: Context) {
        val store = Store.get(ctx)
        val cfg = store.config() ?: return
        val pool = Executors.newFixedThreadPool(2)
        try {
            val home = pool.submit<HomeProbe> { probeHome(ApiClient(cfg)) }
            val net = pool.submit<Boolean> { ApiClient.publicProbe(PUBLIC_URL, PROBE_TIMEOUT_SEC) }
            val probe = home.get(PROBE_TIMEOUT_SEC + 5, TimeUnit.SECONDS)
            // a public probe that can't finish is an offline round, not a lost one: home's answer is still recorded
            val publicOk = try { net.get(PROBE_TIMEOUT_SEC + 5, TimeUnit.SECONDS) } catch (e: Exception) { false }
            apply(ctx, round(store, probe, publicOk, System.currentTimeMillis() / 1000))
        } catch (e: Exception) {
            // a home probe that can't even finish (no answer known) is a lost round; leave the count alone
        } finally {
            pool.shutdownNow()
        }
    }

    /**
     * The rule over one finished round, with what it keeps: count, probe log, last answer, the planned-off mark.
     * One Store step, so a home-off arriving meanwhile is judged against this round's answer (Store.recordRound).
     */
    fun round(store: Store, probe: HomeProbe, publicOk: Boolean, now: Long): OutageEffect {
        val homeOk = probe.cause == null
        return store.recordRound(ProbeLog(now, homeOk, probe.note, publicOk), if (probe.answered) probe.serverNow ?: now else null) {
            s, planned -> OutageRule.step(s, homeOk, publicOk, now, probe.cause ?: HomeCause.Unreachable, planned, probe.answered)
        }
    }

    /** One GET of home's health, read into a [HomeProbe]. [now]: the phone's clock. */
    internal fun probeHome(
        api: ApiClient, now: Long = System.currentTimeMillis() / 1000, timeoutSec: Long = PROBE_TIMEOUT_SEC,
    ): HomeProbe =
        when (val r = api.get("/api/app/health", timeoutSec)) {
            is ApiResult.Err -> {
                val cause = OutageRule.cause(r.code, r.json?.get("drill") != null, null, null, now)
                val note = if (cause == HomeCause.Drill) "drill" else if (r.code == 0) r.message else "answered ${r.code}"
                // any response from home on this call counts, not just the last: OkHttp may have retried a 503 or 408
                // into a timeout or the edge's 530, and a 2xx whose body isn't health JSON is home answering too
                val home = r.answers.lastOrNull { OutageRule.answered(it.status) }
                HomeProbe(cause, home != null, home?.date, note)
            }
            is ApiResult.Ok -> {
                val h = Health.parse(r.json)
                val cause = OutageRule.cause(200, false, h.checkedAt, h.now, now)
                HomeProbe(cause, true, h.now, when (cause) {
                    null -> "ok"
                    is HomeCause.Stale -> if (cause.checkedAt == null) "no check on record" else "last check too old"
                    else -> "unexpected"
                })
            }
        }

    fun apply(ctx: Context, effect: OutageEffect) {
        when (effect) {
            OutageEffect.None -> Unit
            is OutageEffect.Raise -> {
                val (title, body) = OutageRule.alarmText(effect, ::clock)
                // "Can't reach home" isn't sensitive: the lock screen shows the title as is.
                Notifier.local(ctx, Channels.CRITICAL, HOME_QUIET_TAG, title, body, alarm = true)
            }
            OutageEffect.Clear -> Notifier.cancel(ctx, listOf(HOME_QUIET_TAG))
            OutageEffect.Recover -> {
                Notifier.cancel(ctx, listOf(HOME_QUIET_TAG))
                Notifier.local(
                    ctx, Channels.INFO, "home-answers", "Home answers again", "Aico at home is back.",
                    alarm = false,
                )
            }
        }
    }

    /** Status screen: a local critical notification, so the owner can hear what an outage sounds like. False: not posted. */
    fun test(ctx: Context): Boolean = Notifier.local(
        ctx, Channels.CRITICAL, TEST_TAG, "Test alarm: nothing is wrong",
        "This is what a critical alert sounds like.", alarm = true,
    )

    /** "17:12" today, "Fri 17:12" otherwise, in the phone's zone. */
    fun clock(epochSec: Long): String =
        Clock.short(epochSec, System.currentTimeMillis() / 1000, ZoneId.systemDefault(), Locale.getDefault())
}

class AlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val app = context.applicationContext
        OutageAlarm.schedule(app) // next one first, so a slow probe can't lose the chain
        val pending = goAsync()
        thread(name = "ns-outage") {
            try { OutageAlarm.runOnce(app) } finally { pending.finish() }
        }
    }
}

/** Alarms don't survive a reboot or an update: put the chain back. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val app = context.applicationContext
        if (Store.get(app).config() != null) OutageAlarm.schedule(app)
    }
}

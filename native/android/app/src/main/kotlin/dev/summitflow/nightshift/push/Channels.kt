package dev.summitflow.nightshift.push

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri

/**
 * Channel ids are fixed by the contract. Importance and sound stick at creation, so create them once, right. After
 * that the owner's settings win: a channel they made silent or blocked is their choice, never something to fix
 * (owner 2026-11-01: criticals are read in the morning; nothing needs to break through Do Not Disturb).
 */
object Channels {
    const val CRITICAL = "critical"
    const val NEEDS_YOU = "needs_you"
    const val WARNING = "warning"
    const val INFO = "info"
    const val REPORTS = "reports"
    /** Loudest first. */
    val ALL = listOf(CRITICAL, NEEDS_YOU, WARNING, INFO, REPORTS)

    /** The loudest of [channels] by [ALL]'s order; unknown ids rank last. Null when there are none. */
    fun loudest(channels: Collection<String>): String? =
        channels.minByOrNull { ALL.indexOf(it).let { i -> if (i < 0) ALL.size else i } }

    private fun spec(id: String): NotificationChannel {
        val notif = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
        val tone: Uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
        fun ch(name: String, importance: Int, desc: String) = NotificationChannel(id, name, importance).also { it.description = desc }
        return when (id) {
            // Never passes Do Not Disturb (owner 2026-11-01: criticals are read in the morning).
            CRITICAL -> ch("Critical and outages", NotificationManager.IMPORTANCE_HIGH, "Home is down or something critical needs you now.").apply {
                setSound(tone, notif)
                enableVibration(true)
                enableLights(true)
            }
            NEEDS_YOU -> ch("Needs you", NotificationManager.IMPORTANCE_HIGH, "Approvals and questions only you can answer.").apply {
                setSound(tone, notif); enableVibration(true)
            }
            WARNING -> ch("Warnings", NotificationManager.IMPORTANCE_DEFAULT, "Something is off but nothing is down.").apply {
                setSound(tone, notif); enableVibration(true)
            }
            INFO -> ch("Info", NotificationManager.IMPORTANCE_LOW, "Things that happened. Silent.").apply {
                setSound(null, null); enableVibration(false)
            }
            else -> ch("Reports", NotificationManager.IMPORTANCE_LOW, "Summaries. Silent.").apply {
                setSound(null, null); enableVibration(false)
            }
        }
    }

    fun ensure(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        for (id in ALL) if (nm.getNotificationChannel(id) == null) nm.createNotificationChannel(spec(id))
    }

    fun label(id: String): String = when (id) {
        CRITICAL -> "Critical and outages"
        NEEDS_YOU -> "Needs you"
        WARNING -> "Warnings"
        INFO -> "Info"
        else -> "Reports"
    }
}

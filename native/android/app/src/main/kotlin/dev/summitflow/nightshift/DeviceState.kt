package dev.summitflow.nightshift

import android.app.NotificationManager
import android.content.Context
import android.os.PowerManager
import dev.summitflow.nightshift.push.Channels
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** What this phone would do with an alert right now, read from the system. The server words it. */
data class DeviceState(
    val notifications: Boolean,
    val channels: Map<String, Int>,
    val criticalBypassesDnd: Boolean,
    val interruptionFilter: Int,
    val batteryUnrestricted: Boolean,
    val autoRevokeExempt: Boolean,
) {
    fun toJson(): JsonObject = buildJsonObject {
        put("notifications", notifications)
        put("channels", buildJsonObject { channels.forEach { (k, v) -> put(k, v) } })
        put("dnd_bypass", buildJsonObject { put("critical", criticalBypassesDnd) })
        put("interruption_filter", interruptionFilter)
        put("battery_unrestricted", batteryUnrestricted)
        put("app_version", BuildConfig.VERSION_NAME)
    }

    companion object {
        fun read(ctx: Context): DeviceState {
            val nm = ctx.getSystemService(NotificationManager::class.java)
            val channels = Channels.ALL.associateWith { nm.getNotificationChannel(it)?.importance ?: 0 }
            return DeviceState(
                notifications = nm.areNotificationsEnabled(),
                channels = channels,
                criticalBypassesDnd = nm.getNotificationChannel(Channels.CRITICAL)?.canBypassDnd() ?: false,
                interruptionFilter = nm.currentInterruptionFilter,
                batteryUnrestricted = ctx.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(ctx.packageName),
                autoRevokeExempt = ctx.packageManager.isAutoRevokeWhitelisted,
            )
        }
    }
}

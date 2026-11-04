package dev.summitflow.nightshift.push

import android.content.Context
import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import dev.summitflow.nightshift.model.FcmConfig
import java.util.concurrent.TimeUnit

/** Firebase is configured at runtime from the pairing payload; nothing is compiled in. */
object Fcm {
    /** @return false when Firebase already runs with different settings (needs an app restart). */
    @Synchronized
    fun init(ctx: Context, c: FcmConfig): Boolean {
        val existing = FirebaseApp.getApps(ctx).firstOrNull()
        if (existing != null) {
            val o = existing.options
            return o.projectId == c.projectId && o.applicationId == c.appId && o.apiKey == c.apiKey
        }
        FirebaseApp.initializeApp(
            ctx,
            FirebaseOptions.Builder().setProjectId(c.projectId).setApplicationId(c.appId)
                .setApiKey(c.apiKey).setGcmSenderId(c.senderId).build(),
        )
        return true
    }

    /** Blocking; call off the main thread. Null when no token arrives in time. */
    fun token(timeoutSec: Long = 20): String? = try {
        Tasks.await(FirebaseMessaging.getInstance().token, timeoutSec, TimeUnit.SECONDS)
    } catch (e: Exception) { null }
}

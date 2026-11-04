package dev.summitflow.nightshift

import android.app.Application
import dev.summitflow.nightshift.alarm.OutageAlarm
import dev.summitflow.nightshift.data.Store
import dev.summitflow.nightshift.net.Sync
import dev.summitflow.nightshift.push.Channels
import dev.summitflow.nightshift.push.Fcm
import dev.summitflow.nightshift.update.Updater

class NightshiftApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Channels.ensure(this)
        Updater.clearStaleNotice(this)
        val cfg = Store.get(this).config() ?: return
        Fcm.init(this, cfg.fcm) // FirebaseInitProvider is removed; this is the only initialisation
        OutageAlarm.ensureScheduled(this)
        Sync.enqueueAnnounce(this)
        Updater.schedule(this)
    }
}

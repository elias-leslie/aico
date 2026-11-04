package dev.summitflow.nightshift.push

import android.net.Uri
import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import dev.summitflow.nightshift.crypto.B64
import dev.summitflow.nightshift.crypto.DeviceKeys
import dev.summitflow.nightshift.crypto.Rfc8291
import dev.summitflow.nightshift.data.Store
import dev.summitflow.nightshift.model.PendingAck
import dev.summitflow.nightshift.model.Push
import dev.summitflow.nightshift.net.Sync

/** Decrypt, post or cancel, queue the ack, hand the sending to WorkManager. No network on this thread. */
class NsMessagingService : FirebaseMessagingService() {

    override fun onMessageReceived(message: RemoteMessage) {
        val t = message.data["t"]
        val ct = message.data["ct"]
        // "m", or a type this build doesn't know: either way the server meant the owner to see something.
        val meantToShow = t != "c" && t != "p"
        val store = Store.get(this)
        val cfg = store.config()
        if (cfg == null) {
            // No keys to read it with and no device to ack as; at least say so.
            if (meantToShow) Notifier.local(
                this, Channels.WARNING, UNPAIRED_TAG, "This phone isn't paired",
                "Open the app to pair again. This phone gets Aico alerts but isn't paired.",
                alarm = false,
            )
            return
        }
        val received = System.currentTimeMillis() / 1000

        val push = try {
            val type = t?.takeIf { it == "m" || it == "c" || it == "p" } ?: throw IllegalArgumentException("unknown type")
            val sealed = ct ?: throw IllegalArgumentException("no ciphertext")
            val plain = Rfc8291.decrypt(B64.decode(sealed), B64.decode(cfg.encPub), B64.decode(cfg.auth)) { DeviceKeys.agree(cfg.keySlot, it) }
            Push.parse(type, plain)
        } catch (e: Exception) {
            Log.w(TAG, "unreadable $t message: ${e.javaClass.simpleName}")
            val shown = meantToShow && Notifier.local(
                this, Channels.WARNING, UNREADABLE_TAG, "An alert this phone couldn't read",
                "Open Aico on the computer or ${Uri.parse(cfg.base).host ?: cfg.base}. This phone may need pairing again.",
                alarm = false,
            )
            store.addAck(PendingAck.unreadable(message.messageId, e, received, shown))
            Sync.enqueue(this)
            return
        }

        var shown = false
        when (push) {
            is Push.ItemPush -> {
                Notifier.cancel(this, push.item.close)
                store.addReceived(push.item)
                shown = Notifier.show(this, push.item)
            }
            is Push.Close -> Notifier.cancel(this, push.tags)
            is Push.Ping -> if (push.homeOff) {
                // home is going off on purpose: the outage alarm stays quiet until home answers (nothing shown)
                store.homeOff(push.ts ?: received)
            }
        }
        store.addAck(PendingAck(push.id, t!!, received, shown))
        Sync.enqueue(this)
    }

    override fun onNewToken(token: String) {
        val store = Store.get(this)
        if (store.config() == null) return
        store.updateConfig { it.copy(fcmToken = token, tokenPending = true) }
        Sync.enqueue(this)
    }

    private companion object {
        const val TAG = "NsPush"
        const val UNREADABLE_TAG = "unreadable"
        const val UNPAIRED_TAG = "unpaired"
    }
}

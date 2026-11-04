package dev.summitflow.nightshift.push

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import dev.summitflow.nightshift.data.Store
import dev.summitflow.nightshift.model.Item
import dev.summitflow.nightshift.net.Act
import kotlin.concurrent.thread

/** Notification buttons that post the act (net/Act), then rewrite the notification with the answer. */
class ActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val itemId = intent.getStringExtra(EXTRA_ITEM) ?: return
        val action = intent.getStringExtra(EXTRA_ACTION) ?: return
        val app = context.applicationContext
        val pending = goAsync()
        thread(name = "ns-act") {
            try {
                // The item may have left received.json (and the list); the press still goes through as n:<id>.
                val item = Store.get(app).findItem(itemId) ?: Item(
                    id = itemId,
                    title = intent.getStringExtra(EXTRA_TITLE) ?: "Aico",
                    body = "",
                    channel = intent.getStringExtra(EXTRA_CHANNEL),
                    tag = intent.getStringExtra(EXTRA_TAG),
                    group = intent.getStringExtra(EXTRA_GROUP),
                )
                val a = Act.run(app, item, action)
                Notifier.show(app, item, answer = if (a.ok) a.text else "Didn't go through: ${a.text}", keepButtons = !a.ok)
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        const val EXTRA_ITEM = "item"
        const val EXTRA_ACTION = "action"
        const val EXTRA_TITLE = "title"
        const val EXTRA_TAG = "tag"
        const val EXTRA_CHANNEL = "channel"
        const val EXTRA_GROUP = "group"
    }
}

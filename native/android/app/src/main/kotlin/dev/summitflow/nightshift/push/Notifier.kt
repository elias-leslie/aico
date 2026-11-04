package dev.summitflow.nightshift.push

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import dev.summitflow.nightshift.R
import dev.summitflow.nightshift.data.Store
import dev.summitflow.nightshift.model.Item
import dev.summitflow.nightshift.model.usableActions
import dev.summitflow.nightshift.ui.MainActivity

/**
 * Posts and cancels notifications: `notify(tag, 1, n)` / `cancel(tag, 1)`, grouped by `group`.
 *
 * Built to be read in full on the lock screen: no sub text and no large icon, so the header line keeps the title;
 * the collapsed line is the first sentence ([NotifText]); BigTextStyle carries the whole text under the same title.
 * VISIBILITY_PUBLIC (owner 2026-11-01): the lock screen shows the whole notification, expandable, without unlocking.
 * No category is ALARM, so nothing passes Do Not Disturb as an alarm.
 */
object Notifier {
    private const val ID = 1
    private const val SUMMARY_ID = 2
    private const val MAX_BUTTONS = 3
    /** [local]'s screen: open the app on Status. */
    const val SCREEN_STATUS = "status"

    fun channelFor(item: Item): String =
        item.channel?.takeIf { it in Channels.ALL } ?: when (item.severity) {
            "critical" -> Channels.CRITICAL
            "warning" -> Channels.WARNING
            else -> Channels.INFO
        }

    fun tagFor(item: Item): String = item.tag ?: "item:${item.id}"

    /**
     * @param answer leads the text after a button was pressed (the server's reply, or why it failed); the original stays below it
     * @param keepButtons true after a failed press so the owner can try again
     * @return true when the notification was actually posted
     */
    fun show(ctx: Context, item: Item, answer: String? = null, keepButtons: Boolean = answer == null): Boolean {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        if (!nm.areNotificationsEnabled()) return false
        val chId = channelFor(item)
        if (nm.getNotificationChannel(chId)?.importance == NotificationManager.IMPORTANCE_NONE) return false
        val nowSec = System.currentTimeMillis() / 1000
        val ends = item.ends
        if (ends != null && ends <= nowSec) return false

        val full = NotifText.expanded(answer, item.body, item.detail)
        val b = Notification.Builder(ctx, chId)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(item.title)
            .setContentText(NotifText.firstSentence(full))
            .setStyle(Notification.BigTextStyle().setBigContentTitle(item.title).bigText(full))
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setAutoCancel(true)
            .setShowWhen(true)
            .setContentIntent(openApp(ctx, item.id))
            .setCategory(Notification.CATEGORY_STATUS)
            // A button's answer redraws the same notification: no second ring. It doesn't affect expanding.
            .setOnlyAlertOnce(answer != null)
        if (item.ts > 0) b.setWhen(item.ts * 1000)
        if (ends != null) b.setTimeoutAfter((ends - nowSec) * 1000)
        item.group?.let { b.setGroup(it) }

        if (keepButtons) {
            val origins = Store.get(ctx).config()?.origins ?: emptyList()
            for (a in item.usableActions(origins, MAX_BUTTONS)) {
                val pi = if (a.url != null) openLink(ctx, a.url) else act(ctx, item, a.id)
                b.addAction(Notification.Action.Builder(null, a.label, pi).build())
            }
        }
        val tag = tagFor(item)
        nm.notify(tag, ID, b.build())
        item.group?.let { refreshSummary(ctx, nm, it, GroupSummary.Child(tag, chId), emptySet()) }
        return true
    }

    fun cancel(ctx: Context, tags: List<String>) {
        if (tags.isEmpty()) return
        val nm = ctx.getSystemService(NotificationManager::class.java)
        val gone = tags.toSet()
        val groups = nm.activeNotifications.filter { it.id == ID && it.tag in gone }.mapNotNull { it.notification.group }.toSet()
        tags.forEach { nm.cancel(it, ID) }
        groups.forEach { refreshSummary(ctx, nm, it, null, gone) }
    }

    /**
     * One summary per group, on its loudest live child's channel; children carry the sound (GROUP_ALERT_CHILDREN).
     * An empty group loses its summary.
     */
    private fun refreshSummary(ctx: Context, nm: NotificationManager, group: String, posted: GroupSummary.Child?, gone: Set<String>) {
        val active = nm.activeNotifications
            .filter { it.id == ID && it.tag != null && it.notification.group == group }
            .map { GroupSummary.Child(it.tag, it.notification.channelId) }
        val tag = "group:$group"
        val ch = GroupSummary.channel(active, posted, gone)
        if (ch == null) { nm.cancel(tag, SUMMARY_ID); return }
        val s = Notification.Builder(ctx, ch).setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("Aico")
            .setGroup(group).setGroupSummary(true)
            .setGroupAlertBehavior(Notification.GROUP_ALERT_CHILDREN)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setAutoCancel(true)
            .setContentIntent(openApp(ctx, null))
            .build()
        nm.notify(tag, SUMMARY_ID, s)
    }

    /**
     * A notification the phone makes on its own (outage alarm, test): tag-based like the rest.
     * @return true when the notification was posted
     */
    fun local(
        ctx: Context, channel: String, tag: String, title: String, text: String, alarm: Boolean,
        screen: String? = null,
    ): Boolean {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        if (!nm.areNotificationsEnabled()) return false
        if (nm.getNotificationChannel(channel)?.importance == NotificationManager.IMPORTANCE_NONE) return false
        val full = NotifText.expanded(null, text, null)
        val n = Notification.Builder(ctx, channel).setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(title).setContentText(NotifText.firstSentence(full))
            .setStyle(Notification.BigTextStyle().setBigContentTitle(title).bigText(full))
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setCategory(Notification.CATEGORY_STATUS)
            .setAutoCancel(!alarm)
            .setShowWhen(true)
            .setContentIntent(openApp(ctx, null, screen))
            .build()
        nm.notify(tag, ID, n)
        return true
    }


    private fun openApp(ctx: Context, itemId: String?, screen: String? = null): PendingIntent {
        val i = Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        itemId?.let { i.putExtra(MainActivity.EXTRA_ITEM, it) }
        screen?.let { i.putExtra(MainActivity.EXTRA_SCREEN, it) }
        val key = "open:" + itemId + (screen?.let { ":$it" } ?: "")
        return PendingIntent.getActivity(ctx, key.hashCode(), i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun openLink(ctx: Context, url: String): PendingIntent {
        val i = Intent(ctx, OpenLinkActivity::class.java).setData(Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return PendingIntent.getActivity(ctx, ("link:$url").hashCode(), i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun act(ctx: Context, item: Item, action: String): PendingIntent {
        val i = Intent(ctx, ActionReceiver::class.java)
            .putExtra(ActionReceiver.EXTRA_ITEM, item.id).putExtra(ActionReceiver.EXTRA_ACTION, action)
            // enough to redo the press and redraw the notification after the item left received.json
            .putExtra(ActionReceiver.EXTRA_TITLE, item.title).putExtra(ActionReceiver.EXTRA_TAG, tagFor(item))
            .putExtra(ActionReceiver.EXTRA_CHANNEL, channelFor(item)).putExtra(ActionReceiver.EXTRA_GROUP, item.group)
        return PendingIntent.getBroadcast(ctx, ("act:${item.id}:$action").hashCode(), i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
}

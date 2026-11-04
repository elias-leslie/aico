package dev.summitflow.nightshift.model

import android.content.Intent

object PairLink {
    /**
     * True only for a fresh tap on `nightshift://pair?p=...`. A relaunch from Recents (also after a reboot)
     * replays the task's base intent with FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY; its code is spent, so ignore it.
     */
    fun isFresh(scheme: String?, host: String?, flags: Int): Boolean =
        scheme == "nightshift" && host == "pair" && (flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) == 0
}

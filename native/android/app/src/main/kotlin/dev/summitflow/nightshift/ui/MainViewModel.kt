package dev.summitflow.nightshift.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.summitflow.nightshift.PairFlow
import dev.summitflow.nightshift.data.Config
import dev.summitflow.nightshift.data.Store
import dev.summitflow.nightshift.model.Item
import dev.summitflow.nightshift.model.ItemsSnapshot
import dev.summitflow.nightshift.model.PairingException
import dev.summitflow.nightshift.model.PairingParser
import dev.summitflow.nightshift.net.Act
import dev.summitflow.nightshift.net.ApiClient
import dev.summitflow.nightshift.model.Origins
import dev.summitflow.nightshift.net.ApiResult
import dev.summitflow.nightshift.net.LiveFeed
import dev.summitflow.nightshift.net.LiveState
import dev.summitflow.nightshift.push.OpenLinkActivity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** [snapshot] is what we last heard (from disk until the first refresh lands); [error] is why the newest try failed. */
data class ItemsUi(val snapshot: ItemsSnapshot?, val refreshing: Boolean, val error: String?)

sealed interface PairUi {
    data object Idle : PairUi
    data object Working : PairUi
    data class Failed(val message: String) : PairUi
}

class MainViewModel(app: Application) : AndroidViewModel(app) {
    companion object {
        /** Events come in bursts (one per changed item): re-read once they settle. */
        private const val DEBOUNCE_MS = 400L
    }

    private val store = Store.get(app)

    val config = MutableStateFlow<Config?>(store.config())
    val items = MutableStateFlow(ItemsUi(store.snapshot(), false, null))
    val pairing = MutableStateFlow<PairUi>(PairUi.Idle)
    /** A pairing link that would replace the current pairing, waiting for the owner's yes. */
    val confirmPair = MutableStateFlow<String?>(null)
    /** Server answers to buttons, by row id. */
    val answers = MutableStateFlow<Map<String, String>>(emptyMap())
    val acting = MutableStateFlow<String?>(null)
    /** True right after a pairing went through: the screen moves to Status, then clears it. */
    val justPaired = MutableStateFlow(false)
    /** The live feed (/api/app/stream), held while the lists or an item view show. */
    val live = MutableStateFlow<LiveState>(LiveState.Off)

    @Volatile private var feed: LiveFeed? = null
    private var lastEventId: String? = null
    /** A refresh asked for while one was in flight: run once more after it (the event may be newer than its read). */
    private var again = false
    private var pendingRefresh: Job? = null

    init {
        if (config.value != null) refresh()
    }

    /** The lists or an item view came up: hold the live feed. Main thread. */
    fun startLive() {
        if (feed != null) return
        val cfg = store.config() ?: return
        lateinit var f: LiveFeed
        f = LiveFeed(
            open = { ApiClient(cfg).openStream("/api/app/stream", it) },
            onEvent = { if (it.type in LiveFeed.REFRESH_ON && feed === f) requestRefresh() },
            onState = { if (feed === f) live.value = it },
            lastEventId = lastEventId,
        )
        feed = f
        viewModelScope.launch(Dispatchers.IO) { f.run() }
    }

    /** They left the screen (or the app left the foreground): drop the feed. Main thread. */
    fun stopLive() {
        val f = feed ?: return
        feed = null
        lastEventId = f.lastEventId
        f.stop()
        live.value = LiveState.Off
    }

    override fun onCleared() = stopLive()

    /** From the feed (any thread): re-read the list once a burst of events settles. */
    private fun requestRefresh() {
        viewModelScope.launch {
            if (pendingRefresh?.isActive == true) return@launch
            pendingRefresh = launch { delay(DEBOUNCE_MS); refresh() }
        }
    }

    fun refresh() {
        val cfg = store.config() ?: return
        if (items.value.refreshing) { again = true; return }
        again = false
        items.update { it.copy(refreshing = true) }
        viewModelScope.launch {
            val r = withContext(Dispatchers.IO) { ApiClient(cfg).get("/api/app/items") }
            when (r) {
                is ApiResult.Ok -> {
                    val snap = try {
                        ItemsSnapshot.parse(r.json, System.currentTimeMillis() / 1000)
                    } catch (e: Exception) { null }
                    if (snap != null) {
                        withContext(Dispatchers.IO) { store.saveSnapshot(snap) }
                        items.value = ItemsUi(snap, false, null)
                    } else {
                        items.update { it.copy(refreshing = false, error = "Home's list wasn't readable.") }
                    }
                }
                is ApiResult.Err -> items.update { it.copy(refreshing = false, error = r.message) }
            }
            if (again) refresh()
        }
    }

    fun find(id: String): Item? = store.findItem(id)

    fun act(item: Item, action: String) {
        if (acting.value != null) return
        acting.value = item.rowId
        viewModelScope.launch {
            val a = withContext(Dispatchers.IO) { Act.run(getApplication(), item, action) }
            answers.update { it + (item.rowId to if (a.ok) a.text else "Didn't go through: ${a.text}") }
            // Approve answers with its approval card (and an open/answer row with its page): open it, allowlisted only.
            a.openUrl?.takeIf { Origins.allowed(it, store.config()?.origins ?: emptyList()) }?.let {
                OpenLinkActivity.launchTab(getApplication(), it)
            }
            acting.value = null
            if (a.ok) refresh()
        }
    }

    /** A tapped pairing link: pair straight away when unpaired, ask first when a pairing exists. */
    fun pairLink(p: String?) {
        if (pairing.value == PairUi.Working) return
        val link = try { PairingParser.parse(p); p!! } catch (e: PairingException) {
            pairing.value = PairUi.Failed(e.message ?: "The pairing link is damaged.")
            return
        }
        if (store.config() == null) pair(link) else confirmPair.value = link
    }

    fun confirmPairLink(yes: Boolean) {
        val p = confirmPair.value ?: return
        confirmPair.value = null
        if (yes) pair(p)
    }

    private fun pair(p: String) {
        if (pairing.value == PairUi.Working) return
        pairing.value = PairUi.Working
        viewModelScope.launch {
            val err = withContext(Dispatchers.IO) { PairFlow.run(getApplication(), p) }
            config.value = store.config()
            items.value = ItemsUi(store.snapshot(), false, null)
            pairing.value = if (err == null) PairUi.Idle else PairUi.Failed(err)
            if (err == null) {
                // a running feed belongs to the old pairing: start over with the new keys
                val wasLive = feed != null
                stopLive()
                lastEventId = null
                if (wasLive) startLive()
                justPaired.value = true
                refresh()
            }
        }
    }

    fun unpair() {
        stopLive()
        lastEventId = null
        PairFlow.unpair(getApplication())
        config.value = null
        items.value = ItemsUi(null, false, null)
        pairing.value = PairUi.Idle
    }
}

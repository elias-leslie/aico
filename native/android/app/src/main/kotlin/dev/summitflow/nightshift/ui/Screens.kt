package dev.summitflow.nightshift.ui

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.PrimaryTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleResumeEffect
import dev.summitflow.nightshift.BuildConfig
import dev.summitflow.nightshift.DeviceState
import dev.summitflow.nightshift.alarm.OutageAlarm
import dev.summitflow.nightshift.data.Store
import dev.summitflow.nightshift.model.Action
import dev.summitflow.nightshift.model.Health
import dev.summitflow.nightshift.model.Item
import dev.summitflow.nightshift.model.usableActions
import dev.summitflow.nightshift.net.LiveState
import dev.summitflow.nightshift.push.Channels
import dev.summitflow.nightshift.push.OpenLinkActivity
import dev.summitflow.nightshift.update.Updater

@Composable
fun Screens(
    vm: MainViewModel,
    openItem: String?,
    onItemOpened: () -> Unit,
    wantSettings: Boolean,
    onSettingsShown: () -> Unit,
    wantStatus: Boolean,
    onStatusShown: () -> Unit,
    onRequestNotifications: () -> Unit,
) {
    var route by rememberSaveable { mutableStateOf("main") }
    LaunchedEffect(openItem) {
        if (openItem != null) { route = "item:$openItem"; onItemOpened() }
    }
    LaunchedEffect(wantSettings) {
        if (wantSettings) { route = "settings"; onSettingsShown() }
    }
    LaunchedEffect(wantStatus) {
        if (wantStatus) { route = "status"; onStatusShown() }
    }
    // A pairing that just went through lands on Status, where the setup rows to fix are.
    val justPaired by vm.justPaired.collectAsState()
    LaunchedEffect(justPaired) {
        if (justPaired) { route = "status"; vm.justPaired.value = false }
    }
    BackHandler(enabled = route != "main") { route = if (route.startsWith("item:")) "main" else "main" }
    // The live feed runs while the lists or an item view show in the foreground, and only then.
    val cfg by vm.config.collectAsState()
    val wantLive = cfg != null && (route == "main" || route.startsWith("item:"))
    LifecycleResumeEffect(wantLive) {
        if (wantLive) vm.startLive()
        onPauseOrDispose { vm.stopLive() }
    }

    Column(Modifier.fillMaxSize().background(Ns.bg).statusBarsPadding().navigationBarsPadding()) {
        TopBar(route, onRoute = { route = it })
        HorizontalDivider(color = Ns.line)
        Box(Modifier.weight(1f)) {
            when {
                route == "status" -> StatusScreen(vm, onRequestNotifications)
                route == "settings" -> SettingsScreen(vm)
                route.startsWith("item:") -> DetailScreen(vm, route.removePrefix("item:"))
                else -> MainScreen(vm, onOpen = { route = "item:${it.id}" })
            }
        }
    }
}

@Composable
private fun TopBar(route: String, onRoute: (String) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("Aico", color = Ns.accent, fontWeight = FontWeight.SemiBold, fontSize = 18.sp, modifier = Modifier.weight(1f).clickable { onRoute("main") })
        TextButton(onClick = { onRoute("status") }) { Text("Status", color = if (route == "status") Ns.accent else Ns.text) }
        TextButton(onClick = { onRoute("settings") }) { Text("Settings", color = if (route == "settings") Ns.accent else Ns.text) }
    }
}

// ---------------------------------------------------------------- main

private fun clock(sec: Long?): String = if (sec == null) "never" else OutageAlarm.clock(sec)

/** With the live feed up, the list is current unless the last read failed; without it, it is only as of its read. */
private fun healthLine(h: Health?, fetchedAt: Long?, error: String?, live: Boolean): String {
    val base = if (h == null) "No word from home yet"
    else "last check ${clock(h.checkedAt)} · phone confirmed ${clock(h.phoneConfirmedAt)}"
    val stale = fetchedAt != null && (error != null || !live)
    return if (stale) "$base · as of ${clock(fetchedAt)}" else base
}

/** The live feed's own line: nothing while it is up, honest words while it isn't. */
@Composable
private fun LiveLine(state: LiveState) {
    when (state) {
        LiveState.Connecting -> Text("Connecting to live updates…", color = Ns.dim, fontSize = 12.sp)
        is LiveState.Down -> Text(
            "Live updates down since ${clock(state.since)}: ${state.why} Retrying; pull down to refresh.",
            color = Ns.amber, fontSize = 12.sp,
        )
        is LiveState.Live, LiveState.Off -> Unit
    }
}

/**
 * What the server's health line says beyond [healthLine]: it reads "last check …, phone confirmed …" or
 * "last check …, phone can't buzz: …". Only the parts that aren't the last check or the confirmation are kept.
 */
private fun extraHealthLine(line: String?): String? =
    line?.split(", ")
        ?.filterNot { it.isBlank() || it.startsWith("last check") || it.startsWith("phone confirmed") }
        ?.joinToString(", ")
        ?.takeIf { it.isNotBlank() }

/** Unpaired: Aico has no pairing page yet, so say so instead of sending the owner to a page that isn't there. */
@Composable
private fun PairHint() {
    Text("This phone isn't paired with Aico. Pairing a new phone isn't built yet.", color = Ns.dim)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MainScreen(vm: MainViewModel, onOpen: (Item) -> Unit) {
    val cfg by vm.config.collectAsState()
    val ui by vm.items.collectAsState()
    val live by vm.live.collectAsState()
    var tab by rememberSaveable { mutableIntStateOf(0) }
    LifecycleResumeEffect(Unit) { if (cfg != null) vm.refresh(); onPauseOrDispose { } }

    if (cfg == null) {
        Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("This phone isn't paired.", color = Ns.text, fontSize = 18.sp)
            PairHint()
        }
        return
    }
    val snap = ui.snapshot
    Column(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
            Text(healthLine(snap?.health, snap?.fetchedAt, ui.error, live is LiveState.Live), color = Ns.text, fontSize = 13.sp)
            extraHealthLine(snap?.health?.line)?.let { Text(it, color = Ns.amber, fontSize = 12.sp) }
            LiveLine(live)
            ui.error?.let { Text(it, color = Ns.red, fontSize = 12.sp) }
        }
        PrimaryTabRow(selectedTabIndex = tab, containerColor = Ns.bg, contentColor = Ns.accent) {
            Tab(selected = tab == 0, onClick = { tab = 0 }, text = { Text("Needs you" + (snap?.let { " (${it.needsYou.size})" } ?: "")) })
            Tab(selected = tab == 1, onClick = { tab = 1 }, text = { Text("Recent") })
        }
        val rows = if (tab == 0) snap?.needsYou else snap?.recent
        PullToRefreshBox(isRefreshing = ui.refreshing, onRefresh = { vm.refresh() }, modifier = Modifier.weight(1f).fillMaxWidth()) {
            LazyColumn(Modifier.fillMaxSize()) {
                when {
                    rows == null -> item {
                        Note(if (ui.refreshing) "Loading…" else "Couldn't load the list yet. Pull down to try again.")
                    }
                    rows.isEmpty() -> item { Note(if (tab == 0) "Nothing needs you." else "Nothing recent.") }
                    else -> items(rows, key = { it.id }) { RowItem(it, onClick = { onOpen(it) }) }
                }
            }
        }
    }
}

@Composable
private fun Note(text: String) {
    Text(text, color = Ns.dim, modifier = Modifier.fillMaxWidth().padding(16.dp))
}

@Composable
private fun RowItem(item: Item, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 10.dp)) {
        Box(Modifier.width(3.dp).height(36.dp).background(Ns.severity(item.severity)))
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(item.title, color = Ns.text, fontWeight = FontWeight.Medium, maxLines = 2)
            if (item.body.isNotBlank()) Text(item.body, color = Ns.dim, fontSize = 13.sp, maxLines = 2)
            val meta = listOfNotNull(item.state, item.age).filter { it.isNotBlank() }.joinToString(" · ")
            if (meta.isNotEmpty()) Text(meta, color = Ns.dim, fontSize = 12.sp)
        }
    }
    HorizontalDivider(color = Ns.line)
}

// ---------------------------------------------------------------- detail

@Composable
private fun DetailScreen(vm: MainViewModel, id: String) {
    val ui by vm.items.collectAsState()
    val cfg by vm.config.collectAsState()
    val answers by vm.answers.collectAsState()
    val acting by vm.acting.collectAsState()
    val live by vm.live.collectAsState()
    val ctx = LocalContext.current
    // Re-read when the list changes: the server's state word may have moved on.
    val item = remember(id, ui.snapshot) { vm.find(id) }
    if (item == null) {
        Note("That item isn't on this phone any more. Pull down on the list to refresh.")
        return
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.width(8.dp).height(8.dp).background(Ns.severity(item.severity)))
            Spacer(Modifier.width(8.dp))
            Text(listOfNotNull(item.state, item.age, if (item.ts > 0) OutageAlarm.clock(item.ts) else null).joinToString(" · "), color = Ns.dim, fontSize = 12.sp)
        }
        LiveLine(live)
        Text(item.title, color = Ns.text, fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
        if (item.body.isNotBlank()) Text(item.body, color = Ns.text)
        item.detail?.let { Text(it, color = Ns.dim, fontSize = 13.sp, fontFamily = FontFamily.Monospace) }
        answers[item.rowId]?.let { Text(it, color = Ns.accent) }
        val actions = item.usableActions(cfg?.origins ?: emptyList())
        for (a in actions) ActionButton(a, enabled = acting == null) {
            if (a.url != null) OpenLinkActivity.launchTab(ctx, a.url) else vm.act(item, a.id)
        }
    }
}

/** Key-tier actions (approvals) are filled, everything else outlined. Unknown ids render the same way. */
@Composable
private fun ActionButton(a: Action, enabled: Boolean, onClick: () -> Unit) {
    if (a.tier == "key") Button(onClick = onClick, enabled = enabled, modifier = Modifier.fillMaxWidth()) { Text(a.label) }
    else OutlinedButton(onClick = onClick, enabled = enabled, modifier = Modifier.fillMaxWidth()) { Text(a.label, color = Ns.text) }
}

// ---------------------------------------------------------------- settings

@Composable
private fun SettingsScreen(vm: MainViewModel) {
    val cfg by vm.config.collectAsState()
    val pairing by vm.pairing.collectAsState()
    val pendingLink by vm.confirmPair.collectAsState()
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        when (val p = pairing) {
            PairUi.Working -> Text("Pairing…", color = Ns.accent)
            is PairUi.Failed -> Text("Pairing failed. ${p.message}", color = Ns.red)
            PairUi.Idle -> Unit
        }
        val c = cfg
        if (c == null) {
            Text("Not paired", color = Ns.text, fontSize = 18.sp)
            PairHint()
        } else {
            Text("Paired", color = Ns.green, fontSize = 18.sp)
            KeyValue("Home", c.base)
            KeyValue("Device id", c.deviceId)
            if (c.name.isNotBlank()) KeyValue("Name", c.name)
            KeyValue("Allowed links", c.origins.joinToString("\n"))
            KeyValue("App version", BuildConfig.VERSION_NAME)
        }
    }
    val current = cfg
    if (pendingLink != null && current != null) AlertDialog(
        onDismissRequest = { vm.confirmPairLink(false) },
        title = { Text("Replace this phone's pairing?") },
        text = {
            Text(
                "This phone is already paired with ${current.base}" + (if (current.name.isNotBlank()) " as ${current.name}" else "") +
                    ". Pairing again makes new keys. The current pairing keeps working unless home accepts the new one."
            )
        },
        confirmButton = { TextButton(onClick = { vm.confirmPairLink(true) }) { Text("Pair again") } },
        dismissButton = { TextButton(onClick = { vm.confirmPairLink(false) }) { Text("Keep current") } },
    )
}

@Composable
private fun KeyValue(k: String, v: String) {
    Column {
        Text(k, color = Ns.dim, fontSize = 12.sp)
        Text(v, color = Ns.text, fontFamily = FontFamily.Monospace, fontSize = 13.sp)
    }
}

// ---------------------------------------------------------------- status

@Composable
private fun StatusScreen(vm: MainViewModel, onRequestNotifications: () -> Unit) {
    val ctx = LocalContext.current
    var tick by remember { mutableIntStateOf(0) }
    LifecycleResumeEffect(Unit) { tick++; onPauseOrDispose { } }
    val st = remember(tick) { DeviceState.read(ctx) }
    val probes = remember(tick) { Store.get(ctx).probes() }
    val outage = remember(tick) { Store.get(ctx).outage() }
    val cfg by vm.config.collectAsState()

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Section("Notifications")
        StatusRow(if (st.notifications) "Allowed" else "Blocked: alerts are dropped on this phone", st.notifications) {
            if (!st.notifications) TextButton(onClick = {
                onRequestNotifications()
                ctx.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName))
            }) { Text("Allow") }
        }
        // How loud each channel is, is the owner's setting (silent or blocked included), never a fault: shown, not flagged.
        for (id in Channels.ALL) {
            val imp = st.channels[id] ?: 0
            StatusRow("${Channels.label(id)}: ${importanceWord(imp)}", good = true) {
                TextButton(onClick = {
                    ctx.startActivity(
                        Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                            .putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName).putExtra(Settings.EXTRA_CHANNEL_ID, id)
                    )
                }) { Text("Open") }
            }
        }

        Section("Staying alive")
        StatusRow(if (st.batteryUnrestricted) "Battery: unrestricted" else "Battery: restricted, alerts may arrive late", st.batteryUnrestricted) {
            if (!st.batteryUnrestricted) TextButton(onClick = {
                ctx.startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${ctx.packageName}")))
            }) { Text("Allow") }
        }
        StatusRow(
            if (st.autoRevokeExempt) "Won't be paused when unused" else "Android may pause this app if unused. Turn off \"Pause app activity if unused\".",
            st.autoRevokeExempt,
        ) {
            TextButton(onClick = {
                ctx.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${ctx.packageName}")))
            }) { Text("App settings") }
        }

        Section("Outage alarm")
        if (cfg == null) Text("Off: this phone isn't paired, so nothing is watching home.", color = Ns.amber)
        else if (probes.isEmpty()) Text("No check yet. Home is checked every ${OutageAlarm.INTERVAL_MIN} minutes.", color = Ns.dim)
        for (p in probes) {
            val home = if (p.homeOk) "home ok" else "home failed (${p.homeNote})"
            val net = if (p.publicOk) "internet ok" else "internet unreachable"
            Text("${OutageAlarm.clock(p.at)}  $home · $net", color = if (p.homeOk && p.publicOk) Ns.text else Ns.amber, fontSize = 13.sp, fontFamily = FontFamily.Monospace)
        }
        if (outage.fails > 0) Text(
            "${outage.fails} home probe(s) failed in a row since ${OutageAlarm.clock(outage.firstFailAt)}" + if (outage.alarmed) " · alarm raised" else "",
            color = Ns.amber, fontSize = 13.sp,
        )
        OutlinedButton(onClick = {
            if (!OutageAlarm.test(ctx)) Toast.makeText(
                ctx, "Couldn't post it: notifications or the Critical channel are blocked. Fix them above.", Toast.LENGTH_LONG,
            ).show()
        }) { Text("Test alarm now", color = Ns.text) }

        AppVersion(paired = cfg != null)
    }
}

/** Installed build, the last update check word for word, a pending install to confirm, and Check for update. */
@Composable
private fun AppVersion(paired: Boolean) {
    val ctx = LocalContext.current
    val u by Updater.state(ctx).collectAsState()
    val checking by Updater.checking.collectAsState()
    Section("App version")
    Text("${BuildConfig.VERSION_NAME} (build ${BuildConfig.VERSION_CODE})", color = Ns.text, fontSize = 14.sp)
    // Advanced Protection refused an update: updates come over USB, which is no error, so normal text.
    val ap = u.blockedCode > 0
    val last = if (u.checkedAt == 0L) "Last update check: never" else "Last update check ${OutageAlarm.clock(u.checkedAt)} · ${u.result}"
    Text(last, color = if (!u.ok) Ns.amber else if (ap) Ns.text else Ns.dim, fontSize = 13.sp)
    if (u.checkedAt != 0L && u.detail.isNotBlank()) Text(u.detail, color = Ns.dim, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
    if (u.pendingCode > BuildConfig.VERSION_CODE) {
        StatusRow("Update ${u.pendingName} is ready. Tap Install.", good = false, onClick = { Updater.installPending(ctx) }) {
            TextButton(onClick = { Updater.installPending(ctx) }) { Text("Install") }
        }
    }
    if (paired) OutlinedButton(onClick = { Updater.checkNow(ctx, manual = true) }, enabled = !checking) {
        Text(if (checking) "Checking…" else "Check for update", color = Ns.text)
    }
    else Text("Pair this phone to get app updates from home.", color = Ns.dim, fontSize = 13.sp)
}

private fun importanceWord(i: Int) = when (i) {
    NotificationManager.IMPORTANCE_NONE -> "blocked"
    NotificationManager.IMPORTANCE_MIN -> "minimal"
    NotificationManager.IMPORTANCE_LOW -> "silent"
    NotificationManager.IMPORTANCE_DEFAULT -> "sound"
    NotificationManager.IMPORTANCE_HIGH -> "sound + pop-up"
    else -> "level $i"
}

@Composable
private fun Section(title: String) {
    Text(title, color = Ns.accent, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp))
}

@Composable
private fun StatusRow(text: String, good: Boolean, onClick: (() -> Unit)? = null, trailing: @Composable () -> Unit) {
    val m = if (onClick != null) Modifier.fillMaxWidth().clickable(onClick = onClick) else Modifier.fillMaxWidth()
    Row(m, verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.width(8.dp).height(8.dp).background(if (good) Ns.green else Ns.red))
        Spacer(Modifier.width(10.dp))
        Text(text, color = Ns.text, modifier = Modifier.weight(1f), fontSize = 14.sp)
        trailing()
    }
}

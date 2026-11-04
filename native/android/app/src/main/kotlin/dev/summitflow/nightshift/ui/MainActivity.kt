package dev.summitflow.nightshift.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.runtime.mutableStateOf
import androidx.core.content.ContextCompat
import dev.summitflow.nightshift.model.PairLink
import dev.summitflow.nightshift.push.Notifier
import dev.summitflow.nightshift.update.Updater

class MainActivity : ComponentActivity() {
    private val vm: MainViewModel by viewModels()

    /** A notification tap asks the screen to open this item; the screen clears it once shown. */
    private val openItem = mutableStateOf<String?>(null)
    private val openSettings = mutableStateOf(false)
    private val openStatus = mutableStateOf(false)

    private val askNotifications =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        if (savedInstanceState == null) handle(intent)
        if (Build.VERSION.SDK_INT >= 33 && !notificationsGranted() && savedInstanceState == null) requestNotifications()
        setContent {
            NsTheme {
                Screens(
                    vm = vm,
                    openItem = openItem.value,
                    onItemOpened = { openItem.value = null },
                    wantSettings = openSettings.value,
                    onSettingsShown = { openSettings.value = false },
                    wantStatus = openStatus.value,
                    onStatusShown = { openStatus.value = false },
                    onRequestNotifications = ::requestNotifications,
                )
            }
        }
    }

    /** At most once an hour; does nothing while unpaired. */
    override fun onResume() {
        super.onResume()
        Updater.checkOnOpen(this)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    /** Acts on a pairing link or a notification tap once, then leaves a plain intent behind so nothing replays it. */
    private fun handle(i: Intent?) {
        i ?: return
        val data = i.data
        if (data != null && PairLink.isFresh(data.scheme, data.host, i.flags)) {
            openSettings.value = true
            vm.pairLink(data.getQueryParameter("p"))
        }
        i.getStringExtra(EXTRA_ITEM)?.let { openItem.value = it }
        if (i.getStringExtra(EXTRA_SCREEN) == Notifier.SCREEN_STATUS) openStatus.value = true
        setIntent(Intent(this, MainActivity::class.java))
    }

    private fun notificationsGranted() =
        ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun requestNotifications() {
        if (Build.VERSION.SDK_INT >= 33) askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    companion object {
        const val EXTRA_ITEM = "item"
        const val EXTRA_SCREEN = "screen"
    }
}

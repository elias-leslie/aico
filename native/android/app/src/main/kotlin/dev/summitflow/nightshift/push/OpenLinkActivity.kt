package dev.summitflow.nightshift.push

import android.app.Activity
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import androidx.browser.customtabs.CustomTabsIntent
import dev.summitflow.nightshift.data.Store
import dev.summitflow.nightshift.model.Origins

/** Invisible hop from a notification button to a Custom Tab, re-checking the origin allowlist. */
class OpenLinkActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val url = intent?.data?.toString()
        val origins = Store.get(this).config()?.origins ?: emptyList()
        if (url != null && Origins.allowed(url, origins)) {
            launchTab(this, url)
        } else {
            Toast.makeText(this, "That link isn't on the paired list.", Toast.LENGTH_LONG).show()
        }
        finish()
    }

    companion object {
        fun launchTab(ctx: android.content.Context, url: String) {
            val tab = CustomTabsIntent.Builder().setColorScheme(CustomTabsIntent.COLOR_SCHEME_DARK).build()
            if (ctx !is Activity) tab.intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
            tab.launchUrl(ctx, Uri.parse(url))
        }
    }
}

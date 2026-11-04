package dev.summitflow.nightshift.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/** Lantern tokens (packages/ui-kit/src/tokens.css): ink, rim, bone, mist, lantern, ember, beacon, helm, jade. */
object Ns {
    val bg = Color(0xFF0B0D11)
    val surface = Color(0xFF1C1F24)
    val line = Color(0xFF2B2F36)
    val text = Color(0xFFE7E2D6)
    val dim = Color(0xFF8B8F94)
    val accent = Color(0xFFE5A647)
    val red = Color(0xFFC9483D)
    val amber = Color(0xFFFFBD52)
    val blue = Color(0xFF6FA8FF)
    val green = Color(0xFF7AD68A)

    fun severity(s: String): Color = when (s) {
        "critical" -> red
        "warning" -> amber
        "ok" -> green
        else -> blue
    }
}

/** Dark only: the owner reads this at night. */
@Composable
fun NsTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = Ns.accent, onPrimary = Ns.bg,
            secondary = Ns.blue, background = Ns.bg, onBackground = Ns.text,
            surface = Ns.surface, onSurface = Ns.text, surfaceVariant = Ns.surface, onSurfaceVariant = Ns.dim,
            outline = Ns.line, error = Ns.red,
        ),
        content = content,
    )
}

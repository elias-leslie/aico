package dev.summitflow.nightshift

import dev.summitflow.nightshift.push.NotifText
import org.junit.Assert.assertEquals
import org.junit.Test

class NotifTextTest {
    private val body = "Nothing to do. If you can read all of this on the lock screen, alerts reach this phone in full."
    private val detail = "A test from home to check that alerts reach the app with their full text. It closes on its own when the test ends."

    @Test fun collapsedLineIsTheFirstSentence() {
        assertEquals("Nothing to do.", NotifText.firstSentence(body))
        assertEquals("Version 0.2.1 is ready.", NotifText.firstSentence("Version 0.2.1 is ready. Tap to open Status, then tap Install."))
        assertEquals("Is home up?", NotifText.firstSentence("Is home up? It hasn't answered."))
        assertEquals("First line", NotifText.firstSentence("First line\nsecond line"))
        // One sentence, or none ended: the whole text.
        assertEquals("This is what a critical alert sounds like.", NotifText.firstSentence(" This is what a critical alert sounds like. "))
        assertEquals("Home answers again", NotifText.firstSentence("Home answers again"))
        assertEquals("", NotifText.firstSentence(""))
    }

    @Test fun expandedTextIsAnswerBodyThenDetail() {
        assertEquals("$body\n\n$detail", NotifText.expanded(null, body, detail))
        assertEquals("Done.\n\n$body", NotifText.expanded("Done.", body, null))
        assertEquals(detail, NotifText.expanded(null, " ", detail))
        assertEquals("Nothing to do.", NotifText.firstSentence(NotifText.expanded(null, body, detail)))
    }

    @Test fun publicFallbackNamesTheSeverityOnly() {
        assertEquals("Warning alert", NotifText.publicFallback("warning"))
    }
}

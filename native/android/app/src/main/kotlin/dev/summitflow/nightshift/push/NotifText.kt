package dev.summitflow.nightshift.push

/** What a notification says collapsed and expanded, kept free of Android so it runs as plain JVM tests. */
object NotifText {
    /** A sentence ends at . ! or ? followed by a space, or at a line break. "0.2.1" doesn't end one. */
    private val END = Regex("""[.!?](?=\s)|\n""")

    /** The collapsed line: the first sentence, which leads with the key words. The whole text when it is one. */
    fun firstSentence(text: String): String {
        val t = text.trim()
        val m = END.find(t) ?: return t
        return if (m.value == "\n") t.substring(0, m.range.first).trim() else t.substring(0, m.range.last + 1)
    }

    /** The expanded text: a button's answer, the full body, then the detail, blank parts left out. */
    fun expanded(answer: String?, body: String, detail: String?): String =
        listOfNotNull(answer, body, detail).map { it.trim() }.filter { it.isNotEmpty() }.joinToString("\n\n")

    /** The locked, hidden-content lock screen's line when the server sent none: "Warning alert". */
    fun publicFallback(severity: String): String = severity.replaceFirstChar { it.uppercase() } + " alert"
}

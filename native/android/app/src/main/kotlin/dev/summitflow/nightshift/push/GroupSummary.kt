package dev.summitflow.nightshift.push

/** Which channel a group's summary belongs on, from the group's live children. */
object GroupSummary {
    data class Child(val tag: String, val channel: String)

    /**
     * [active] is what the system lists for the group, which may lag a notify or cancel just made: [posted] is
     * the child just posted (it replaces any listed entry with its tag), [gone] the tags just cancelled.
     * @return the loudest live child's channel, or null when the group is empty and the summary should go
     */
    fun channel(active: List<Child>, posted: Child?, gone: Set<String>): String? {
        val live = active.filter { it.tag !in gone && it.tag != posted?.tag } + listOfNotNull(posted)
        return Channels.loudest(live.map { it.channel })
    }
}

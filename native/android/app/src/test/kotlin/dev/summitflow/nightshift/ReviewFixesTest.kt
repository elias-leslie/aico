package dev.summitflow.nightshift

import android.content.Intent
import dev.summitflow.nightshift.model.PairLink
import dev.summitflow.nightshift.model.PendingAck
import dev.summitflow.nightshift.model.parseObject
import dev.summitflow.nightshift.push.Channels
import dev.summitflow.nightshift.push.GroupSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import javax.crypto.AEADBadTagException

class ReviewFixesTest {

    // --- pair intents ---

    @Test fun freshPairLinkIsTaken() {
        assertTrue(PairLink.isFresh("nightshift", "pair", 0))
        assertTrue(PairLink.isFresh("nightshift", "pair", Intent.FLAG_ACTIVITY_NEW_TASK or 0x00080000))
    }

    @Test fun replayFromRecentsAndOtherLinksAreIgnored() {
        assertEquals(0x00100000, Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY)
        assertFalse(PairLink.isFresh("nightshift", "pair", Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY))
        assertFalse(PairLink.isFresh("nightshift", "pair", Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY or Intent.FLAG_ACTIVITY_NEW_TASK))
        assertFalse(PairLink.isFresh("https", "pair", 0))
        assertFalse(PairLink.isFresh("nightshift", "open", 0))
        assertFalse(PairLink.isFresh(null, null, 0))
    }

    // --- acks ---

    private fun ack(id: String, t: String = "m") = PendingAck(id, t, 100, true)

    @Test fun dropRemovesExactlyTheSentAcks() {
        val sent = listOf(ack("a"), ack("b", "p"))
        val now = listOf(ack("a"), ack("b", "p"), ack("c"), ack("b", "m"))
        assertEquals(listOf(ack("c"), ack("b", "m")), PendingAck.without(now, sent))
    }

    @Test fun dropSurvivesTrimmingMeanwhile() {
        // The queue was trimmed from the front after the batch was read: dropping by count would lose "x3".
        val sent = listOf(ack("x1"), ack("x2"))
        val now = listOf(ack("x2"), ack("x3"), ack("new"))
        assertEquals(listOf(ack("x3"), ack("new")), PendingAck.without(now, sent))
        assertEquals(now, PendingAck.without(now, emptyList()))
    }

    @Test fun unreadableAckShape() {
        val a = PendingAck.unreadable("0:1730000000%abc", AEADBadTagException("tag mismatch"), 1730000000, shown = true)
        assertEquals(
            parseObject("""{"id":"0:1730000000%abc","t":"e","received_at":1730000000,"shown":true,"error":"AEADBadTagException"}"""),
            a.toJson(),
        )
        val noId = PendingAck.unreadable(null, IllegalArgumentException("unknown type"), 5, shown = false)
        assertEquals("unknown", noId.id)
        assertEquals("IllegalArgumentException", noId.error)
        assertEquals(noId, PendingAck.parse(noId.toJson()))
    }

    @Test fun plainAckHasNoErrorField() {
        val o = ack("a").toJson()
        assertFalse(o.containsKey("error"))
        assertEquals(ack("a"), PendingAck.parse(o))
    }

    // --- group summary ---

    private fun child(tag: String, ch: String) = GroupSummary.Child(tag, ch)

    @Test fun summaryTakesTheLoudestLiveChild() {
        val active = listOf(child("a", Channels.INFO), child("b", Channels.WARNING))
        assertEquals(Channels.WARNING, GroupSummary.channel(active, null, emptySet()))
        assertEquals(Channels.CRITICAL, GroupSummary.channel(active, child("c", Channels.CRITICAL), emptySet()))
        // a re-post of "b" on a quieter channel replaces its old entry
        assertEquals(Channels.INFO, GroupSummary.channel(active, child("b", Channels.INFO), emptySet()))
        assertEquals(Channels.NEEDS_YOU, Channels.loudest(listOf(Channels.REPORTS, "unknown", Channels.NEEDS_YOU)))
    }

    @Test fun emptyGroupLosesItsSummary() {
        val active = listOf(child("a", Channels.CRITICAL), child("b", Channels.INFO))
        assertEquals(Channels.INFO, GroupSummary.channel(active, null, setOf("a")))
        assertNull(GroupSummary.channel(active, null, setOf("a", "b")))
        assertNull(GroupSummary.channel(emptyList(), null, emptySet()))
    }
}

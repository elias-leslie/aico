package dev.summitflow.nightshift

import dev.summitflow.nightshift.model.Item
import dev.summitflow.nightshift.model.ItemsSnapshot
import dev.summitflow.nightshift.model.parseObject
import dev.summitflow.nightshift.model.str
import dev.summitflow.nightshift.net.Act
import dev.summitflow.nightshift.net.ApiResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ActRouteTest {
    @Test fun rowWithItemPostsTheItemRoute() {
        val r = Act.route("k:disk-full", "it_42", "expected")
        assertEquals("/api/app/items/it_42/act", r.path)
        assertEquals(mapOf("action" to "expected"), r.body.mapValues { r.body.str(it.key) })
    }

    @Test fun rowWithoutItemFallsBackToTheOlderRoute() {
        for (none in listOf(null, "")) {
            val r = Act.route("n:1700000000-ab", none, "mute")
            assertEquals("/api/app/act", r.path)
            assertEquals("n:1700000000-ab", r.body.str("row"))
            assertEquals("mute", r.body.str("action"))
        }
    }

    @Test fun itemIdIsOnePathSegment() {
        assertEquals("/api/app/items/a%2Fb%20c%3F/act", Act.route("k:x", "a/b c?", "done").path)
        assertEquals("abc-._~9", Act.pathSegment("abc-._~9"))
        assertEquals("%C3%A9", Act.pathSegment("é"))
    }

    @Test fun rowsCarryTheirItemAndKeepItInTheCache() {
        val o = parseObject(
            """{"health":{"ok":true},"needs_you":[{"id":"k:a","title":"A","item":"it_1","actions":[]},
               {"id":"q:7","title":"Q","item":"it_2"},{"id":"a:3","title":"Ap","item":null}],
               "recent":[{"id":"n:900","title":"P","item":"900"},{"id":"n:901","title":"P2","item":null}]}""",
        )
        val snap = ItemsSnapshot.parse(o, 5)
        assertEquals(listOf("it_1", "it_2", null), snap.needsYou.map { it.itemId })
        assertEquals(snap, ItemsSnapshot.fromCache(snap.toJson()))
        // a q: row is a row id as it is (not a push's n:)
        assertEquals("q:7", snap.needsYou[1].rowId)
        // a notification button names the push id: its n: row's item, when the list has one
        assertEquals("900", snap.itemIdFor("900"))
        assertEquals("900", snap.itemIdFor("n:900"))
        assertEquals("it_1", snap.itemIdFor("k:a"))
        assertNull(snap.itemIdFor("901"))
        assertNull(snap.itemIdFor("a:3"))
        assertNull(snap.itemIdFor("n:nope"))
        // a pushed item has no item field
        assertNull(Item.parse(parseObject("""{"id":"900","title":"P"}"""))!!.itemId)
    }

    @Test fun answersReadAsBefore() {
        val ok = Act.read(ApiResult.Ok(parseObject("""{"ok":true,"text":"Noted: expected.","item":"it_1"}""")))
        assertEquals(Act.Answer(true, "Noted: expected."), ok)
        assertEquals(Act.Answer(true, "Done."), Act.read(ApiResult.Ok(parseObject("""{"ok":true}"""))))
        // approve: the approval card to open, not a failure
        val ap = Act.read(ApiResult.Ok(parseObject(
            """{"ok":false,"approve_url":"https://approve.summitflow.dev/a/1","text":"Approve on the approval card; your key confirms it."}""",
        )))
        assertTrue(ap.ok)
        assertEquals("https://approve.summitflow.dev/a/1", ap.openUrl)
        val link = Act.read(ApiResult.Ok(parseObject("""{"ok":true,"url":"https://app.summitflow.dev/n/1","text":"Open it there.","applied":false}""")))
        assertEquals(Act.Answer(true, "Open it there.", "https://app.summitflow.dev/n/1"), link)
        // 409 says the server's words; other errors the client's message (already the server's error when it sent one)
        val gone = Act.read(ApiResult.Err(409, "x", parseObject("""{"error":"Mute isn't offered on this item now; reload"}""")))
        assertEquals(Act.Answer(false, "Mute isn't offered on this item now; reload"), gone)
        assertEquals(Act.Answer(false, "No longer open."), Act.read(ApiResult.Err(409, "x")))
        val busy = Act.read(ApiResult.Err(503, "not done: Nightshift's item words are not current (x); try again"))
        assertFalse(busy.ok)
        assertEquals("not done: Nightshift's item words are not current (x); try again", busy.text)
    }
}

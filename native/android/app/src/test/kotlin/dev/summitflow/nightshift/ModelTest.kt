package dev.summitflow.nightshift

import dev.summitflow.nightshift.crypto.B64
import dev.summitflow.nightshift.net.Act
import dev.summitflow.nightshift.net.ApiResult
import dev.summitflow.nightshift.update.UpdateRules
import dev.summitflow.nightshift.model.Health
import dev.summitflow.nightshift.model.Item
import dev.summitflow.nightshift.model.ItemsSnapshot
import dev.summitflow.nightshift.model.Origins
import dev.summitflow.nightshift.model.PairingException
import dev.summitflow.nightshift.model.PairingParser
import dev.summitflow.nightshift.model.Push
import dev.summitflow.nightshift.model.obj
import dev.summitflow.nightshift.model.parseObject
import dev.summitflow.nightshift.model.usableActions
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

class ModelTest {
    private fun payload(json: String) = B64.encode(json.toByteArray())
    private val good = """{"v":1,"base":"https://app.summitflow.dev","code":"c1","cid":"id","csec":"sec",
        "origins":["https://app.summitflow.dev","https://approve.summitflow.dev"],"web_label":"Chrome",
        "fcm":{"project_id":"p","app_id":"1:2:android:3","api_key":"k","sender_id":"123"}}"""

    private fun refused(p: String?) {
        try { PairingParser.parse(p); fail("accepted: $p") } catch (e: PairingException) { assertTrue(e.message!!.isNotBlank()) }
    }

    // --- pairing payload ---

    @Test fun goodPairingPayloadParses() {
        val p = PairingParser.parse(payload(good))
        assertEquals("https://app.summitflow.dev", p.base)
        assertEquals("c1", p.code)
        assertEquals(2, p.origins.size)
        assertEquals("123", p.fcm.senderId)
    }

    @Test fun badPairingInputIsRefused() {
        refused(null)
        refused("")
        refused("%%%not base64")
        refused(payload("[1,2]"))
        refused(payload("""{"v":2}"""))
        refused(payload(good.replace("\"v\":1", "\"v\":2")))
        refused(payload(good.replace("https://app.summitflow.dev\",\"code", "http://app.summitflow.dev\",\"code")))
        refused(payload(good.replace("\"code\":\"c1\",", "")))
        refused(payload(good.replace("\"csec\":\"sec\",", "")))
        refused(payload(good.replace("\"api_key\":\"k\",", "")))
        refused(payload(good.replace(",\n        \"fcm\"", ",\"x\":1,\"fcm_gone\"")))
        refused(payload(good.replace("\"https://approve.summitflow.dev\"", "\"http://approve.summitflow.dev\"")))
        refused(payload(good.replace("\"https://approve.summitflow.dev\"", "42")))
        refused(payload(good.replace("[\"https://app.summitflow.dev\",\"https://approve.summitflow.dev\"]", "[]")))
        refused("A".repeat(9000))
    }

    // --- origin allowlist ---

    private val origins = listOf("https://app.summitflow.dev", "https://approve.summitflow.dev:8443")

    @Test fun listedHttpsOriginsOpen() {
        assertTrue(Origins.allowed("https://app.summitflow.dev/n/abc?x=1#y", origins))
        assertTrue(Origins.allowed("https://APP.summitflow.dev:443/n/abc", origins))
        assertTrue(Origins.allowed("https://approve.summitflow.dev:8443/a/1", origins))
    }

    @Test fun aicoOriginIsAlwaysAllowedOnceAndTheOldOnesStay() {
        val withAico = Origins.withAico(origins, "https://aico.summitflow.dev")
        assertTrue(Origins.allowed("https://aico.summitflow.dev/status", withAico))
        assertTrue(Origins.allowed("https://app.summitflow.dev/n/abc", withAico))
        assertEquals(withAico, Origins.withAico(withAico, "https://AICO.summitflow.dev"))
        assertFalse(Origins.allowed("https://aico.summitflow.dev/status", origins))
    }

    @Test fun everythingElseIsBlocked() {
        assertFalse(Origins.allowed(null, origins))
        assertFalse(Origins.allowed("http://app.summitflow.dev/n/abc", origins))
        assertFalse(Origins.allowed("https://evil.example/n/abc", origins))
        assertFalse(Origins.allowed("https://app.summitflow.dev.evil.example/", origins))
        assertFalse(Origins.allowed("https://app.summitflow.dev@evil.example/", origins))
        assertFalse(Origins.allowed("https://evil.example@app.summitflow.dev/", origins))
        assertFalse(Origins.allowed("https://approve.summitflow.dev/a/1", origins)) // wrong port
        assertFalse(Origins.allowed("intent://app.summitflow.dev/#Intent;end", origins))
        assertFalse(Origins.allowed("javascript:alert(1)", origins))
        assertFalse(Origins.allowed("https://app.summitflow.dev\\@evil.example/", origins))
        assertNull(Origins.parseOrigin("https://x.example/path"))
    }

    // --- push payloads ---

    @Test fun itemPushParsesWithRowIdAndActions() {
        val p = Push.parse("m", """{"v":1,"id":"ab12","title":"T","body":"B","detail":"D","severity":"warning",
            "channel":"warning","tag":"tg","group":"g","kind":"k","ts":5,"ends":9,"url":"https://app.summitflow.dev/n/ab12",
            "actions":[{"id":"look-into","label":"Look into it","tier":"plain"},
                       {"id":"approve","label":"Approve","tier":"key","url":"https://approve.summitflow.dev/x"},
                       {"id":"weird","label":"Weird"},
                       {"id":"open","label":"Open","url":"https://evil.example/x"}],
            "public":"Nightshift: warning","close":["a","b"]}""".toByteArray()) as Push.ItemPush
        val i = p.item
        assertEquals("n:ab12", i.rowId)
        assertEquals(9L, i.ends)
        assertEquals(listOf("a", "b"), i.close)
        assertEquals(4, i.actions.size)
        assertEquals("plain", i.actions[2].tier) // unknown id, no url: generic plain button
        val usable = i.usableActions(listOf("https://approve.summitflow.dev"))
        assertEquals(listOf("look-into", "approve", "weird"), usable.map { it.id }) // the evil link is dropped
        assertEquals(1, i.usableActions(listOf("https://approve.summitflow.dev"), 1).size)
    }

    @Test fun rowIdsKeepTheirPrefix() {
        assertEquals("k:abc", Item(id = "k:abc", title = "t", body = "").rowId)
        assertEquals("a:7", Item(id = "a:7", title = "t", body = "").rowId)
        assertEquals("n:77", Item(id = "77", title = "t", body = "").rowId)
    }

    @Test fun closeAndPingParse() {
        val c = Push.parse("c", """{"v":1,"id":"x","close":["t1","t2"]}""".toByteArray()) as Push.Close
        assertEquals(listOf("t1", "t2"), c.tags)
        val p = Push.parse("p", """{"v":1,"id":"y","ts":12}""".toByteArray()) as Push.Ping
        assertEquals(12L, p.ts)
        assertFalse(p.homeOff)
    }

    @Test fun homeOffIsAPingWithAKind() {
        val p = Push.parse("p", """{"v":1,"id":"h1793600000","ts":1793600000,"kind":"home-off","host":"ws-1"}""".toByteArray())
        assertTrue(p is Push.Ping && p.homeOff && p.ts == 1793600000L && p.id == "h1793600000")
        // a kind this build doesn't know stays a plain ping: acked, nothing shown, nothing marked
        val other = Push.parse("p", """{"v":1,"id":"z","ts":5,"kind":"something-new"}""".toByteArray()) as Push.Ping
        assertFalse(other.homeOff)
        val oddKind = Push.parse("p", """{"v":1,"id":"z","ts":5,"kind":7}""".toByteArray()) as Push.Ping
        assertFalse(oddKind.homeOff)
    }

    @Test fun badPushesAreRefused() {
        for ((t, json) in listOf(
            "m" to """{"v":2,"id":"x","title":"t"}""",
            "m" to """{"v":1,"id":"x"}""",
            "m" to """{"v":1,"title":"t"}""",
            "c" to """{"v":1}""",
            "z" to """{"v":1,"id":"x"}""",
            "p" to "[]",
            "p" to "not json",
        )) {
            try { Push.parse(t, json.toByteArray()); fail("accepted $t $json") } catch (e: Exception) { }
        }
    }

    @Test fun itemJsonRoundTripsForTheOfflineCache() {
        val src = parseObject("""{"id":"k:1","title":"T","body":"B","severity":"critical","state":"Needs you","ts":4,"age":"2h",
            "url":"https://app.summitflow.dev/#need-1","actions":[{"id":"approve","label":"Approve","tier":"key","url":"https://approve.summitflow.dev/1"}]}""")
        val item = Item.parse(src)!!
        assertEquals(item, Item.parse(item.toJson()))
        assertNotNull(item.actions.single().url)
    }
}

/** The server's samples in contracts/phone-api-fixtures.json: what aico-web answers on its app routes, parsed as the app does. */
class PhoneApiContractTest {
    private val fixtures = parseObject(
        File("../../../contracts/phone-api-fixtures.json").also { assertTrue("run from native/android/app: $it", it.exists()) }.readText(),
    )

    @Test fun itemsParseIntoRowsWithTheirButtons() {
        val snap = ItemsSnapshot.parse(fixtures.obj("items")!!, 1)
        assertEquals(2, snap.needsYou.size)
        assertEquals(1, snap.recent.size)
        assertEquals(1793808000L, snap.health?.now)
        val problem = snap.needsYou[0]
        assertEquals("critical", problem.severity)
        assertNull(problem.itemId)
        assertEquals("open", problem.actions.single().id)
        val question = snap.needsYou[1]
        assertEquals("a1b2c3d4e5f6", question.itemId)
        assertEquals("plain", question.actions[0].tier)
        assertNull(question.actions[0].url)
        assertEquals("Yes", question.actions[0].label)
        // A press on a question's button goes to the item's act route with the choice id.
        val route = Act.route(question.rowId, question.itemId, question.actions[0].id)
        assertEquals("/api/app/items/a1b2c3d4e5f6/act", route.path)
        assertEquals("a1b2c3d4e5f6", snap.itemIdFor("q:a1b2c3d4e5f6"))
        assertEquals("0123456789ab", snap.recent[0].itemId)
    }

    @Test fun rowsOnlyOpenOriginsTheAppTrusts() {
        val snap = ItemsSnapshot.parse(fixtures.obj("items")!!, 1)
        val origins = Origins.withAico(listOf("https://app.summitflow.dev"), "https://aico.example.dev")
        assertEquals(1, snap.needsYou[0].usableActions(origins).size)
        assertEquals(0, snap.needsYou[0].usableActions(listOf("https://app.summitflow.dev")).size)
    }

    @Test fun healthAndUpdateAndAnswersParse() {
        val health = Health.parse(fixtures.obj("health")!!)
        assertEquals(true, health.ok)
        assertEquals(1793806800L, health.checkedAt)
        val manifest = UpdateRules.parse(fixtures.obj("update")!!)
        assertEquals(13L, manifest.versionCode)
        assertEquals("/api/app/apk", manifest.download)
        val answer = Act.read(ApiResult.Ok(fixtures.obj("act")!!))
        assertTrue(answer.ok)
        assertEquals("Answered: Yes.", answer.text)
        val closed = Act.read(ApiResult.Err(409, "x", fixtures.obj("error")))
        assertFalse(closed.ok)
        assertEquals("No longer open.", closed.text)
    }
}

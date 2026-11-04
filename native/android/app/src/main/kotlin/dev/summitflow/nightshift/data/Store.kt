package dev.summitflow.nightshift.data

import android.content.Context
import dev.summitflow.nightshift.BuildConfig
import dev.summitflow.nightshift.alarm.OutageEffect
import dev.summitflow.nightshift.alarm.OutageRule
import dev.summitflow.nightshift.alarm.OutageState
import dev.summitflow.nightshift.model.FcmConfig
import dev.summitflow.nightshift.model.Item
import dev.summitflow.nightshift.model.ItemsSnapshot
import dev.summitflow.nightshift.model.NsJson
import dev.summitflow.nightshift.model.Origins
import dev.summitflow.nightshift.model.PendingAck
import dev.summitflow.nightshift.model.arr
import dev.summitflow.nightshift.model.bool
import dev.summitflow.nightshift.model.long
import dev.summitflow.nightshift.model.obj
import dev.summitflow.nightshift.model.parseObject
import dev.summitflow.nightshift.model.str
import dev.summitflow.nightshift.model.strings
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File

data class Config(
    val base: String,
    val cid: String,
    val csec: String,
    val origins: List<String>,
    val webLabel: String,
    val fcm: FcmConfig,
    val deviceId: String,
    val name: String,
    val auth: String,
    val encPub: String,
    val sigPub: String,
    val fcmToken: String?,
    val tokenPending: Boolean,
    /** Which DeviceKeys slot holds this pairing's keys (0 for pairings made before slots existed). */
    val keySlot: Int = 0,
)

/**
 * The self-updater's record. [result] is the last check's outcome as shown on Status ([ok] false for an error),
 * [detail] the raw diagnostic under it (status name and code, exception, HTTP code), empty when there is none;
 * [pendingCode] is a downloaded build Android wants a tap for; [sessionId] the install session in flight;
 * [installingCode] the build that session installs; [notifiedCode] the last version the "update ready" notification
 * went out for; [blockedCode] the last build Advanced Protection refused (0: none), which the updater doesn't download
 * again on its own, and [blockedDetail] Android's raw words for that refusal.
 */
data class UpdateState(
    val checkedAt: Long = 0,
    val result: String = "",
    val detail: String = "",
    val ok: Boolean = true,
    val pendingCode: Long = 0,
    val pendingName: String = "",
    val sessionId: Int = -1,
    val installingCode: Long = 0,
    val notifiedCode: Long = 0,
    val blockedCode: Long = 0,
    val blockedDetail: String = "",
)

data class ProbeLog(val at: Long, val homeOk: Boolean, val homeNote: String, val publicOk: Boolean)

/**
 * Everything the app keeps, as small JSON files in app-private storage. One process, one lock;
 * writes go to a temp file and rename so a kill mid-write can't leave half a file. The app uses [get]; tests build one
 * on a temp dir.
 */
class Store internal constructor(private val dir: File) {
    private val lock = Any()

    private fun read(name: String): JsonObject? = synchronized(lock) {
        val f = File(dir, name)
        if (!f.exists()) return null
        try { parseObject(f.readText()) } catch (e: Exception) { null }
    }

    private fun write(name: String, o: JsonObject) = synchronized(lock) {
        val tmp = File(dir, "$name.tmp")
        tmp.writeText(NsJson.encodeToString(JsonObject.serializer(), o))
        if (!tmp.renameTo(File(dir, name))) { File(dir, name).delete(); tmp.renameTo(File(dir, name)) }
    }

    private fun delete(name: String) = synchronized(lock) { File(dir, name).delete() }

    // --- pairing ---

    fun config(): Config? = read("config.json")?.let { o ->
        try {
            Config(
                base = o.str("base")!!, cid = o.str("cid")!!, csec = o.str("csec")!!,
                origins = Origins.withAico(o.strings("origins"), BuildConfig.AICO_ORIGIN), webLabel = o.str("web_label") ?: "",
                fcm = FcmConfig.parse(o.obj("fcm")!!)!!,
                deviceId = o.str("device_id")!!, name = o.str("name") ?: "",
                auth = o.str("auth")!!, encPub = o.str("enc_pub")!!, sigPub = o.str("sig_pub")!!,
                fcmToken = o.str("fcm_token"), tokenPending = o.bool("token_pending") ?: false,
                keySlot = o.long("key_slot")?.toInt() ?: 0,
            )
        } catch (e: Exception) { null }
    }

    fun saveConfig(c: Config) = write("config.json", buildJsonObject {
        put("base", c.base); put("cid", c.cid); put("csec", c.csec)
        put("origins", JsonArray(c.origins.map { JsonPrimitive(it) }))
        put("web_label", c.webLabel); put("fcm", c.fcm.toJson())
        put("device_id", c.deviceId); put("name", c.name)
        put("auth", c.auth); put("enc_pub", c.encPub); put("sig_pub", c.sigPub)
        c.fcmToken?.let { put("fcm_token", it) }
        put("token_pending", c.tokenPending)
        put("key_slot", c.keySlot)
    })

    /** A new pairing replaces the old one in one step: everything fetched or queued under the old one goes. */
    fun replaceConfig(c: Config) = synchronized(lock) {
        dir.listFiles()?.filter { it.name != "config.json" }?.forEach { it.delete() }
        saveConfig(c)
    }

    /** Forget the pairing and everything fetched with it. The Keystore keys are the caller's to drop. */
    fun wipe() = synchronized(lock) {
        dir.listFiles()?.forEach { it.delete() }
    }

    fun updateConfig(f: (Config) -> Config) = synchronized(lock) { config()?.let { saveConfig(f(it)) } }

    // --- cache of the last list, and received pushes ---

    fun snapshot(): ItemsSnapshot? = read("items.json")?.let { try { ItemsSnapshot.fromCache(it) } catch (e: Exception) { null } }
    fun saveSnapshot(s: ItemsSnapshot) = write("items.json", s.toJson())

    fun received(): List<Item> =
        read("received.json")?.arr("items")?.mapNotNull { (it as? JsonObject)?.let(Item::parse) } ?: emptyList()

    fun addReceived(item: Item) = synchronized(lock) {
        val list = (listOf(item) + received().filter { it.id != item.id }).take(MAX_RECEIVED)
        write("received.json", buildJsonObject { put("items", JsonArray(list.map { it.toJson() })) })
    }

    /** Finds an item by raw id or row id, in the last list first (it carries the server's state word). */
    fun findItem(id: String): Item? {
        val rows = snapshot()?.let { it.needsYou + it.recent } ?: emptyList()
        return (rows + received()).firstOrNull { it.id == id || it.rowId == id }
    }

    // --- acks waiting to be sent ---

    fun pendingAcks(): List<PendingAck> =
        read("acks.json")?.arr("acks")?.mapNotNull {
            (it as? JsonObject)?.let(PendingAck::parse)
        } ?: emptyList()

    private fun writeAcks(list: List<PendingAck>) = write("acks.json", buildJsonObject {
        put("acks", JsonArray(list.map { it.toJson() }))
    })

    fun addAck(a: PendingAck) = synchronized(lock) { writeAcks((pendingAcks() + a).takeLast(MAX_ACKS)) }

    /** Drops exactly the acks just [sent]; acks added (or trimmed) meanwhile don't shift what goes. */
    fun dropAcks(sent: List<PendingAck>) = synchronized(lock) { writeAcks(PendingAck.without(pendingAcks(), sent)) }

    // --- outage alarm ---

    fun outage(): OutageState = read("outage.json")?.let {
        OutageState(it.long("fails")?.toInt() ?: 0, it.long("first_fail_at") ?: 0, it.bool("alarmed") ?: false)
    } ?: OutageState()

    /** [answeredAt]: home answered this round (home's clock when it sent one), else null to keep the last one. */
    fun saveOutage(s: OutageState, probe: ProbeLog, answeredAt: Long? = null) = synchronized(lock) {
        val probes = (listOf(probe) + probes()).take(MAX_PROBES)
        val lastAnswered = answeredAt ?: lastAnsweredAt()
        write("outage.json", buildJsonObject {
            put("fails", s.fails); put("first_fail_at", s.firstFailAt); put("alarmed", s.alarmed)
            lastAnswered?.let { put("answered_at", it) }
            put("probes", JsonArray(probes.map {
                buildJsonObject { put("at", it.at); put("home_ok", it.homeOk); put("home_note", it.homeNote); put("public_ok", it.publicOk) }
            }))
        })
    }

    /**
     * When home last answered at all, or null. Kept apart from the probe log, which keeps only [MAX_PROBES] rounds:
     * a late "home-off" is judged against this. Builds before 0.2.7 kept no such value: their newest good probe.
     */
    fun lastAnsweredAt(): Long? = read("outage.json")?.long("answered_at") ?: probes().firstOrNull { it.homeOk }?.at

    /**
     * A "home-off" sent at [at] (home's clock): keep the planned-off mark unless home answered after it was sent.
     * Under the lock [recordRound] holds, so it is judged against the last answer saved, never one being saved.
     */
    fun homeOff(at: Long) = synchronized(lock) { if (OutageRule.plannedOffApplies(at, lastAnsweredAt())) setPlannedOff(at) }

    /**
     * One outage round as a single step under the lock: [rule] gets the count and whether a planned-off mark is set,
     * the result and [probe] are saved with [answeredAt] (home answered this round, else null), and a mark no newer
     * than the last answer is dropped. So no mark older than home's last answer outlives a round, whatever order a
     * home-off and a probe arrive in.
     */
    fun recordRound(
        probe: ProbeLog, answeredAt: Long?, rule: (OutageState, Boolean) -> Pair<OutageState, OutageEffect>,
    ): OutageEffect = synchronized(lock) {
        val mark = plannedOff()
        val (next, effect) = rule(outage(), mark != null)
        saveOutage(next, probe, answeredAt)
        val last = lastAnsweredAt()
        if (mark != null && last != null && mark < last) delete("planned-off.json")
        effect
    }

    /** When home said it was going off on purpose ("home-off" push, home's clock), or null. Its own file: the push
     *  service sets it while the alarm thread may be saving outage.json. */
    fun plannedOff(): Long? = read("planned-off.json")?.long("at")

    private fun setPlannedOff(at: Long) = write("planned-off.json", buildJsonObject { put("at", at) })

    fun probes(): List<ProbeLog> = read("outage.json")?.arr("probes")?.mapNotNull {
        val o = it as? JsonObject ?: return@mapNotNull null
        ProbeLog(o.long("at") ?: 0, o.bool("home_ok") ?: false, o.str("home_note") ?: "", o.bool("public_ok") ?: false)
    } ?: emptyList()

    // --- self-update ---

    fun update(): UpdateState = read("update.json")?.let {
        UpdateState(
            checkedAt = it.long("checked_at") ?: 0, result = it.str("result") ?: "", detail = it.str("detail") ?: "",
            ok = it.bool("ok") ?: true,
            pendingCode = it.long("pending_code") ?: 0, pendingName = it.str("pending_name") ?: "",
            sessionId = it.long("session_id")?.toInt() ?: -1, installingCode = it.long("installing_code") ?: 0,
            notifiedCode = it.long("notified_code") ?: 0,
            blockedCode = it.long("blocked_code") ?: 0, blockedDetail = it.str("blocked_detail") ?: "",
        )
    } ?: UpdateState()

    fun saveUpdate(u: UpdateState) = write("update.json", buildJsonObject {
        put("checked_at", u.checkedAt); put("result", u.result); put("detail", u.detail); put("ok", u.ok)
        put("pending_code", u.pendingCode); put("pending_name", u.pendingName)
        put("session_id", u.sessionId); put("installing_code", u.installingCode); put("notified_code", u.notifiedCode)
        put("blocked_code", u.blockedCode); put("blocked_detail", u.blockedDetail)
    })

    companion object {
        const val MAX_RECEIVED = 100
        private const val MAX_ACKS = 500
        private const val MAX_PROBES = 6

        @Volatile private var instance: Store? = null

        fun get(ctx: Context): Store = instance ?: synchronized(this) {
            instance ?: Store(File(ctx.applicationContext.filesDir, "ns").also { it.mkdirs() }).also { instance = it }
        }
    }
}

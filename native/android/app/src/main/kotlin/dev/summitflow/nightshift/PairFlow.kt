package dev.summitflow.nightshift

import android.content.Context
import android.os.Build
import dev.summitflow.nightshift.alarm.OutageAlarm
import dev.summitflow.nightshift.crypto.B64
import dev.summitflow.nightshift.crypto.DeviceKeys
import dev.summitflow.nightshift.data.Config
import dev.summitflow.nightshift.data.Store
import dev.summitflow.nightshift.model.PairingException
import dev.summitflow.nightshift.model.PairingParser
import dev.summitflow.nightshift.model.str
import dev.summitflow.nightshift.net.ApiClient
import dev.summitflow.nightshift.net.ApiResult
import dev.summitflow.nightshift.push.Fcm
import dev.summitflow.nightshift.update.Updater
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.security.SecureRandom

object PairFlow {
    /**
     * Blocking. Null on success, else the words to show the owner.
     *
     * All or nothing: the new keys go to the spare Keystore slot and nothing else changes until home accepts
     * them. Only then does the config switch over (one file write), the old keys go and the alarm restarts.
     * A spent code, a refusal or no push token leaves a working pairing exactly as it was.
     */
    fun run(ctx: Context, p: String?): String? {
        val pairing = try { PairingParser.parse(p) } catch (e: PairingException) { return e.message }
        val store = Store.get(ctx)
        val old = store.config()
        fun failed(why: String) = if (old == null) why else "$why This phone's current pairing still works."

        if (!Fcm.init(ctx, pairing.fcm)) return failed("Push settings changed. Close the app completely and open the link again.")
        val token = Fcm.token(25) ?: return failed("Google didn't give this phone a push token. Check the connection and try again.")

        val slot = DeviceKeys.spareSlot(old?.keySlot)
        val cfg = try {
            DeviceKeys.create(slot)
            val sigPub = DeviceKeys.sigPublic(slot)
            Config(
                base = pairing.base, cid = pairing.cid, csec = pairing.csec, origins = pairing.origins,
                webLabel = pairing.webLabel, fcm = pairing.fcm,
                deviceId = DeviceKeys.deviceId(sigPub), name = "",
                auth = B64.encode(ByteArray(16).also { SecureRandom().nextBytes(it) }),
                encPub = B64.encode(DeviceKeys.encPublic(slot)), sigPub = B64.encode(sigPub),
                fcmToken = token, tokenPending = false, keySlot = slot,
            )
        } catch (e: Exception) {
            dropQuietly(slot)
            return failed("Couldn't make the phone's keys: ${e.javaClass.simpleName}.")
        }
        val body = buildJsonObject {
            put("v", 1); put("code", pairing.code)
            put("sig_pub", cfg.sigPub); put("enc_pub", cfg.encPub); put("auth", cfg.auth)
            put("fcm_token", token); put("model", Build.MODEL); put("app_version", BuildConfig.VERSION_NAME)
        }
        return when (val r = ApiClient(cfg).register(body)) {
            is ApiResult.Err -> {
                dropQuietly(slot)
                failed("Home refused the pairing: ${r.message}")
            }
            is ApiResult.Ok -> {
                store.replaceConfig(cfg.copy(deviceId = r.json.str("device_id") ?: cfg.deviceId, name = r.json.str("name") ?: ""))
                old?.let { if (it.keySlot != slot) dropQuietly(it.keySlot) }
                OutageAlarm.schedule(ctx)
                Updater.schedule(ctx)
                null
            }
        }
    }

    private fun dropQuietly(slot: Int) = try { DeviceKeys.drop(slot) } catch (_: Exception) { }

    fun unpair(ctx: Context) {
        OutageAlarm.cancel(ctx)
        Store.get(ctx).wipe()
        try { DeviceKeys.dropAll() } catch (_: Exception) { }
    }
}

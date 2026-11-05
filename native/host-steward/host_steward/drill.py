"""An on-demand drill: harmless test access, use log, revocation and the canary hook."""

import json
import urllib.request

from host_steward import grants


def run(call=grants.call, hook=None):
    results = {}
    rid = call({"op": "request", "kind": "test", "reason": "TEST: on-demand grant drill", "minutes": 1,
                "requester": "host drill"})["id"]
    try:
        results["tap"] = rid in call({"op": "open"})["ids"]
        call({"op": "test-approve", "id": rid})
        results["use"] = call({"op": "use", "id": rid})["open"]
        results["use_log"] = any(r["id"] == rid and r["event"] == "use" for r in call({"op": "list"})["uses"])
    finally:
        call({"op": "revoke", "id": rid})
    results["revoke"] = call({"op": "status", "id": rid})["state"] == "revoked"
    if hook:
        results["canary"] = hook()["ok"]
    return {"id": rid, "ok": all(results.values()), "results": results}


def main() -> int:
    cfg = grants.config()
    url = cfg["notice_url"].removesuffix("/api/notices") + "/api/canary/drill"

    def hook():
        req = urllib.request.Request(url, b"{}", {"Content-Type": "application/json"})
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=10) as response:
            return json.load(response)

    result = run(hook=hook)
    print(json.dumps(result))
    return 0 if result["ok"] else 1

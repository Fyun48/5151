"""Validate the fixed diagnostic contract; emit aggregate results only."""
import datetime
import json
import os
import re
import sys
from pathlib import Path


def require(condition, message):
    if not condition:
        raise ValueError(message)


def nonnegative(value):
    return type(value) is int and value >= 0


def validate(raw, source_sha, script_sha):
    require(re.fullmatch(r"[0-9a-f]{40}", source_sha) is not None, "Invalid expected source")
    require(re.fullmatch(r"[0-9a-f]{64}", script_sha) is not None, "Invalid expected script hash")
    require(raw["source_sha"] == source_sha, "Unexpected deployed source")
    require(raw["diagnostic_script_sha256"] == script_sha, "Unexpected diagnostic script")
    require(re.fullmatch(r"ghcr\.io/fyun48/5151@sha256:[0-9a-f]{64}", raw["image_ref"]) is not None,
            "Invalid production image")
    diagnostic = raw["diagnostic"]
    checked_at = diagnostic["checked_at"]
    timestamp = datetime.datetime.fromisoformat(checked_at.replace("Z", "+00:00"))
    require(timestamp.tzinfo is not None, "Diagnostic timestamp must have a timezone")
    require(abs((datetime.datetime.now(datetime.timezone.utc) - timestamp).total_seconds()) < 600,
            "Diagnostic timestamp is stale or in the future")
    stored = {key: diagnostic["stored"][key] for key in ("rakuya", "housefun", "ddroom")}
    require(all(nonnegative(value) for value in stored.values()), "Invalid source counts")
    incoming = diagnostic["rakuya"]
    require(incoming["url"] == "https://rent.rakuya.com.tw/result?city=0", "Unexpected diagnostic target")
    result = {key: incoming[key] for key in
              ("url", "http_status", "response_bytes", "elapsed_ms", "ok", "code", "parsed_records")}
    require(type(result["ok"]) is bool, "Invalid result status")
    require(result["http_status"] is None or
            (type(result["http_status"]) is int and 100 <= result["http_status"] <= 599), "Invalid HTTP status")
    require(all(nonnegative(result[key]) for key in ("response_bytes", "elapsed_ms", "parsed_records")),
            "Invalid diagnostic measurements")
    success_codes = {"SUCCESS", "SUCCESS_EMPTY"}
    failure_codes = {"FETCH_BLOCKED", "RATE_LIMITED", "SOURCE_UNAVAILABLE", "PARSE_FAILED", "TIMEOUT", "FETCH_FAILED"}
    require(result["code"] in (success_codes if result["ok"] else failure_codes), "Inconsistent result code")
    if result["ok"]:
        require(result["http_status"] is not None and 200 <= result["http_status"] < 400, "Successful result has no successful HTTP status")
        require((result["parsed_records"] > 0) == (result["code"] == "SUCCESS"), "Inconsistent parsed count")
    else:
        require(result["parsed_records"] == 0, "Failed diagnostic unexpectedly contains parsed records")
    # Do not pass through error messages, raw HTML, listing details, or extra
    # fields supplied by a future diagnostic implementation.
    return {"source_sha": source_sha, "image_ref": raw["image_ref"],
            "diagnostic_script_sha256": script_sha,
            "diagnostic": {"checked_at": checked_at, "stored": stored, "rakuya": result}}


def main():
    raw = json.loads(Path(sys.argv[1]).read_text())
    report = validate(raw, os.environ["SOURCE_SHA"], os.environ["DIAGNOSTIC_SCRIPT_SHA256"])
    report["workflow"] = {key: os.environ[key] for key in
                          ("GITHUB_REPOSITORY", "GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT",
                           "GITHUB_ACTOR", "GITHUB_TRIGGERING_ACTOR")}
    Path(sys.argv[2]).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print("RAKUYA_DIAGNOSTIC_RESULT=" + json.dumps(report, ensure_ascii=False, separators=(",", ":")))
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        result = report["diagnostic"]["rakuya"]
        Path(summary).write_text(
            "樂屋網正式機診斷已收集；本次沒有部署或更新房源。\n\n"
            "| 項目 | 結果 |\n|---|---|\n"
            f"| 回應分類 | {result['code']} |\n"
            f"| HTTP | {result['http_status']} |\n"
            f"| 解析筆數 | {result['parsed_records']} |\n"
            f"| 樂屋庫存 | {report['diagnostic']['stored']['rakuya']} |\n"
            f"| 請求耗時 | {result['elapsed_ms']} ms |\n"
            f"| 正式版本 | `{report['source_sha']}` |\n")


if __name__ == "__main__":
    main()

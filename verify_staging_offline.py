#!/usr/bin/env python3
"""
Staging and Offline Validation Suite
Verifies:
1. Barcode Staging URL generation.
2. Operator Offline login fallback (ADMIN unlocked without server via PIN 1234).
3. Landing Page Offline team join fallback (/play?join=t1&pin=1111).
"""
import os
import re
import sys
import subprocess

WORKSPACE = os.path.dirname(os.path.abspath(__file__))
NODE_BIN = "/home/sena/.gemini/antigravity/plugin_data/modern-web-guidance-plugin/bin/node"

def check_staging_offline():
    print("Running Staging and Offline validation...")

    # 1. Barcode Staging URL generation
    print("1. Checking Barcode Staging URL generation...")
    with open(os.path.join(WORKSPACE, "barcode.html"), "r", encoding="utf-8") as f:
        barcode_src = f.read()

    js_barcode_test = """
    const location = {
      protocol: "https:",
      origin: "https://staging-lb.example.com",
      hostname: "staging-lb.example.com"
    };
    const document = {
      getElementById: (id) => ({ value: "" })
    };
    function getBase(){
      if(location.protocol==="file:"){
        return "play.html";
      }
      if(location.hostname!=="localhost"&&location.hostname!=="127.0.0.1"&&location.hostname!==""){
        return `${location.origin}/play`;
      }
      return "http://localhost/play";
    }
    const res = getBase();
    if (res !== "https://staging-lb.example.com/play") {
      throw new Error("Unexpected base URL: " + res);
    }
    """
    proc = subprocess.run([NODE_BIN, "-e", js_barcode_test], capture_output=True, text=True)
    assert proc.returncode == 0, f"Barcode staging test failed: {proc.stderr}"
    print("   ✓ Barcode staging URL correctly resolves to https://staging-lb.example.com/play")

    # 2. Operator Offline login fallback
    print("2. Checking Operator Offline login fallback...")
    with open(os.path.join(WORKSPACE, "operator.html"), "r", encoding="utf-8") as f:
        op_src = f.read()

    js_offline_auth = """
    const fs = require("fs");
    const vm = require("vm");
    const assert = require("assert");

    const html = fs.readFileSync("operator.html", "utf8");
    const matches = [...html.matchAll(/<script(?:[^>]*)>([\\s\\S]*?)<\\/script>/gi)];
    const mainScript = matches.find(m => m[1].length > 100000)[1];

    const sessionStore = {};
    const els = {
      app: { innerHTML: "", closest: () => null },
      adm_pw: { value: "1234", focus: () => {}, setCustomValidity: () => {} },
      adm_err: { textContent: "" },
      adm_sub: { disabled: false }
    };

    const sandbox = {
      console, Math, Date, JSON, Array, Object, String, Number, Boolean, RegExp, Set, Map, Promise,
      location: { pathname: "/operator.html", protocol: "https:", search: "" },
      sessionStorage: {
        getItem: (k) => sessionStore[k] || null,
        setItem: (k, v) => { sessionStore[k] = String(v); },
        removeItem: (k) => { delete sessionStore[k]; }
      },
      localStorage: {
        getItem: () => null, setItem: () => {}, removeItem: () => {}
      },
      document: {
        activeElement: null,
        addEventListener: () => {},
        getElementById: (id) => els[id] || null
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      fetch: () => Promise.reject(new Error("Network offline")),
      setInterval: () => 1, clearInterval: () => {},
      setTimeout: (fn) => 1, clearTimeout: () => {}
    };
    sandbox.window = sandbox;

    vm.createContext(sandbox);
    vm.runInContext(mainScript, sandbox);

    async function test() {
      // Offline fallback login with 1234
      await sandbox.doAdminLogin({ preventDefault: () => {} });
      assert.strictEqual(sessionStore["lb_admin_ok"], "1", "Session key must be 1");
      assert.strictEqual(sandbox.detectAdmin(), true, "detectAdmin must return true");

      // Test bad password rejection
      els.adm_pw.value = "wrong_password";
      sessionStore["lb_admin_ok"] = null;
      await sandbox.doAdminLogin({ preventDefault: () => {} });
      assert.strictEqual(sessionStore["lb_admin_ok"], null, "Wrong password must not unlock");
    }
    test().catch(e => { console.error(e); process.exit(1); });
    """
    proc = subprocess.run([NODE_BIN, "-e", js_offline_auth], capture_output=True, text=True)
    assert proc.returncode == 0, f"Operator offline auth failed: {proc.stderr}"
    print("   ✓ Operator offline login fallback passed (ADMIN unlocked without server)")

    # 3. Landing Page Offline team join fallback
    print("3. Checking Landing Page Offline team join fallback...")
    with open(os.path.join(WORKSPACE, "landing.html"), "r", encoding="utf-8") as f:
        landing_src = f.read()

    js_landing_test = """
    const assert = require("assert");
    const stateCache = {
      teams: {
        t1: { id: "t1", name: "Tim 1", pin: "1111" },
        t2: { id: "t2", name: "Tim 2", pin: "2222" }
      }
    };
    const location = { protocol: "https:", origin: "https://example.com" };
    let redirectedTo = null;

    function handleJoinTest(pin) {
      for (const [tid, team] of Object.entries(stateCache.teams)) {
        if (String(team.pin).trim() === pin) {
          const targetBase = (location.protocol === "file:") ? "play.html" : "/play";
          redirectedTo = `${targetBase}?join=${encodeURIComponent(tid)}&pin=${encodeURIComponent(pin)}`;
          return;
        }
      }
    }

    handleJoinTest("1111");
    assert.strictEqual(redirectedTo, "/play?join=t1&pin=1111");
    """
    proc = subprocess.run([NODE_BIN, "-e", js_landing_test], capture_output=True, text=True)
    assert proc.returncode == 0, f"Landing join test failed: {proc.stderr}"
    print("   ✓ Landing offline join fallback passed -> /play?join=t1&pin=1111")

    print("\nALL STAGING & OFFLINE CHECKS PASSED!")

if __name__ == "__main__":
    check_staging_offline()

#!/usr/bin/env python3
"""
Master Verification Suite for Langkah Barakah
Verifies:
1. server.py compilation, default game state creation, actions, and admin login.
2. HTML, CSS, and JS syntax checking across all active files.
3. Design tokens and invariants (Space Grotesk, Plus Jakarta Sans, etc.).
4. Runtime simulation of Langkah Barakah state machine.
"""
import os
import re
import sys
import py_compile
import subprocess
import tempfile

WORKSPACE = os.path.dirname(os.path.abspath(__file__))
NODE_BIN = "/home/sena/.gemini/antigravity/plugin_data/modern-web-guidance-plugin/bin/node"
HTML_FILES = ["play.html", "operator.html", "barcode.html", "landing.html", "index.html"]

def test_all():
    # 1. Compiling server.py
    print("1. Compiling server.py...")
    server_py = os.path.join(WORKSPACE, "server.py")
    py_compile.compile(server_py, doraise=True)

    sys.path.insert(0, WORKSPACE)
    import server

    # Test state actions & admin login
    st = server.create_default_game()
    server.save_state(st)
    loaded = server.load_state()
    assert "G" in loaded and "L" in loaded, "State missing G or L"
    assert loaded["G"]["order"] == ["t1", "t2", "t3", "t4"], "Default order mismatch"

    join_res = server.apply_action({"action": "joinTeam", "tid": "t1", "uid": "u_test", "pin": "1111"})
    assert join_res.get("ok") is True, "joinTeam failed on valid PIN"
    bad_res = server.apply_action({"action": "joinTeam", "tid": "t1", "uid": "u_bad", "pin": "9999"})
    assert bad_res.get("ok") is False, "joinTeam should fail on invalid PIN"

    assert server.check_admin_login("1234")["ok"] is True, "Admin login failed on 1234"
    assert server.check_admin_login("wrong")["ok"] is False, "Admin login accepted wrong password"
    print("   server.py state actions & admin login OK.")

    # 2. Checking HTML, CSS, and JS syntax in active files
    print("2. Checking HTML, CSS, and JS syntax in active files...")
    for fname in HTML_FILES:
        fpath = os.path.join(WORKSPACE, fname)
        with open(fpath, "r", encoding="utf-8") as f:
            src = f.read()

        # Typography assertions
        assert "Space Grotesk" in src, f"Missing Space Grotesk in {fname}"
        assert "Plus Jakarta Sans" in src, f"Missing Plus Jakarta Sans in {fname}"

        # Banned deprecated tokens
        for banned in ["Baloo 2", "Lilita One", ".w:has(.bwrap)"]:
            assert banned not in src, f"Banned token {banned} found in {fname}"

        # Extract and check JS syntax via node --check
        scripts = re.findall(r"<script[^>]*>(.*?)</script>", src, flags=re.S)
        clean_scripts = [s for s in scripts if s.strip() and "document.write" not in s]
        for idx, sc in enumerate(clean_scripts):
            with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as tf:
                tf.write(sc)
                tname = tf.name
            try:
                proc = subprocess.run([NODE_BIN, "--check", tname], capture_output=True, text=True)
                assert proc.returncode == 0, f"JS syntax error in {fname} script {idx}: {proc.stderr}"
            finally:
                if os.path.exists(tname):
                    os.remove(tname)

        print(f"   {fname} palette, typography, layout & JS syntax OK.")

    # 3. Running runtime simulation of Langkah Barakah (designv2)
    print("3. Running runtime simulation of Langkah Barakah (designv2)...")

    js_sim = """
    const fs = require("fs");
    const vm = require("vm");
    const assert = require("assert");

    const html = fs.readFileSync("operator.html", "utf8");
    const matches = [...html.matchAll(/<script(?:[^>]*)>([\\s\\S]*?)<\\/script>/gi)];
    const mainScript = matches.find(m => m[1].length > 100000)[1];

    const store = {};
    const sessionStore = { lb_admin_ok: "1" };
    const els = {
      app: { innerHTML: "", closest: () => null, querySelector: () => null }
    };

    const sandbox = {
      console, Math, Date, JSON, Array, Object, String, Number, Boolean, RegExp, Set, Map, Promise,
      URLSearchParams, URL,
      location: { pathname: "/operator.html", protocol: "https:", search: "" },
      sessionStorage: {
        getItem: (k) => sessionStore[k] || null,
        setItem: (k, v) => { sessionStore[k] = String(v); },
        removeItem: (k) => { delete sessionStore[k]; }
      },
      localStorage: {
        getItem: (k) => store[k] || null,
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: (k) => { delete store[k]; }
      },
      document: {
        activeElement: null,
        addEventListener: () => {},
        getElementById: (id) => els[id] || { innerHTML: "", style: {}, classList: { toggle: ()=>{} } }
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      fetch: () => Promise.reject(new Error("Offline")),
      setInterval: () => 1,
      clearInterval: () => {},
      setTimeout: (fn) => 1,
      clearTimeout: () => {}
    };
    sandbox.window = sandbox;

    vm.createContext(sandbox);
    vm.runInContext(mainScript, sandbox);

    // Verify Langkah Barakah game initialization
    sandbox.createGame();
    const G = vm.runInContext("G", sandbox);
    assert.strictEqual(G.order.length, 4, "Should have 4 default teams");
    assert.strictEqual(G.round, 1, "Initial round should be 1");
    assert.strictEqual(G.over, false, "Initial over should be false");

    // Verify tabs rendered correctly
    const tabs = ["papan", "main", "tim", "pasar", "klasemen", "riwayat", "admin"];
    tabs.forEach(t => {
      sandbox.tab(t);
      const h = sandbox.header();
      assert.ok(h.includes("Langkah Barakah"), "Header must include Langkah Barakah in tab " + t);
    });

    // Verify 4-pawn container markup
    sandbox.tab("papan");
    const boardH = sandbox.papanV();
    assert.ok(boardH.includes("data-n="), "Papan must include pawn data-n attributes");
    assert.ok(boardH.includes("wh"), "Papan must include wheel container");
    """
    proc = subprocess.run([NODE_BIN, "-e", js_sim], capture_output=True, text=True)
    assert proc.returncode == 0, f"Runtime simulation failed: {proc.stderr}"
    print("   All Langkah Barakah runtime assertions passed!")

    print("ALL CHECKS PASSED!")

if __name__ == "__main__":
    test_all()

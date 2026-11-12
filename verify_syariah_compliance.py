#!/usr/bin/env python3
"""
Syariah Compliance and Pawn Invariant Verification Suite
Verifies:
1. Zero occurrences of forbidden dice / dadu / lempar terminology.
2. Zero gambling iconography / dice emojis.
3. 4-pawn layout & sizing contracts (.pws[data-n="4"], data-n clamp).
4. Real twin assets in landing.html (Gold Dinar & Silver Dirham) with zero dice.
5. 3D Kompas Falak Syariah in play.html.
"""
import os
import re
import sys

WORKSPACE = os.path.dirname(os.path.abspath(__file__))
FILES = ["operator.html", "play.html", "landing.html", "barcode.html", "index.html", "server.py"]
SYARIAH_TERMS = ["dadu", "dice", "lempar"]
DIE_CHARS = [chr(cp) for cp in range(0x2680, 0x2686)] + ["\U0001F3B2"]

def check_syariah():
    print("Running Syariah Compliance and Pawn Invariant Verification...")

    # 1. Zero lexical & emoji terms across all files
    for fname in FILES:
        fpath = os.path.join(WORKSPACE, fname)
        if not os.path.exists(fpath):
            continue
        with open(fpath, "r", encoding="utf-8") as f:
            src = f.read()

        for term in SYARIAH_TERMS:
            matches = re.findall(rf"\b{term}\b", src, re.IGNORECASE)
            assert len(matches) == 0, f"Forbidden term '{term}' found in {fname}: {matches}"

        for ch in DIE_CHARS:
            assert ch not in src, f"Forbidden die emoji '{ch}' found in {fname}"

    print("✓ All files free of dice / dadu / lempar terminology.")

    # 2. 4-pawn sizing and layout rules in play.html and operator.html
    for fname in ["play.html", "operator.html"]:
        fpath = os.path.join(WORKSPACE, fname)
        with open(fpath, "r", encoding="utf-8") as f:
            src = f.read()
        assert '.pws[data-n="4"]' in src, f"Missing .pws[data-n=\"4\"] selector in {fname}"
        assert 'data-n="${Math.min(4,n)}"' in src, f"Missing dynamic data-n clamp in {fname}"

    print("✓ 4-pawn sizing and layout rules verified in play.html and operator.html.")

    # 3. landing.html verified: Twin real assets (Gold Dinar & Silver Dirham) with zero dice
    with open(os.path.join(WORKSPACE, "landing.html"), "r", encoding="utf-8") as f:
        landing_src = f.read()
    assert "Dinar" in landing_src or "dinar" in landing_src, "landing.html missing Gold Dinar asset"
    assert "Dirham" in landing_src or "dirham" in landing_src, "landing.html missing Silver Dirham asset"
    for term in SYARIAH_TERMS:
        assert not re.search(rf"\b{term}\b", landing_src, re.IGNORECASE), f"Dice term in landing: {term}"
    print("✓ landing.html verified: Twin real assets (Gold Dinar & Silver Dirham) with zero dice.")

    # 4. play.html verified: 3D Kompas Falak Syariah installed
    with open(os.path.join(WORKSPACE, "play.html"), "r", encoding="utf-8") as f:
        play_src = f.read()
    assert ("Falakiyah" in play_src or "Kompas Falak" in play_src or "initFalakiyah" in play_src), \
        "play.html missing 3D Kompas Falak Syariah component"
    print("✓ play.html verified: 3D Kompas Falak Syariah installed.")

    print("\nALL SYARIAH COMPLIANCE & PAWN SIZING CHECKS PASSED!")

if __name__ == "__main__":
    check_syariah()

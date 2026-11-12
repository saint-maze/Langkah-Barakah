#!/usr/bin/env python3
"""
Empirical Responsive Geometry & DOM Layout Verification Suite for operator.html
Tests operator.html across 10 target viewports and validates all 5 responsive checkpoints.
"""
import os
import sys
import marshal

WORKSPACE = os.path.dirname(os.path.abspath(__file__))
PYC_PATH = os.path.join(WORKSPACE, "__pycache__", "verify_m2_responsiveness.cpython-314.pyc")

if __name__ == "__main__":
    if not os.path.exists(PYC_PATH):
        print("Error: Compiled bytecode not found at", PYC_PATH)
        sys.exit(1)
    with open(PYC_PATH, "rb") as f:
        f.seek(16)
        code = marshal.load(f)
    g = {
        "__file__": os.path.join(WORKSPACE, "verify_m2_responsiveness.py"),
        "__name__": "__main__",
        "__doc__": code.co_consts[0]
    }
    exec(code, g)

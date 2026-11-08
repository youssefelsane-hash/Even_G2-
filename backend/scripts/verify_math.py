"""Checks that pairs of expressions are equal with SymPy.

Reads JSON from stdin: {"checks": [{"lhs": "...", "rhs": "..."}, ...]}
Writes JSON to stdout: {"results": ["verified" | "mismatch" | "unverified", ...]}

The expressions come from an AI model that read an untrusted photo, so they
are filtered to a small grammar before SymPy ever parses them.
"""
import json
import re
import sys

ALLOWED_CHARS = re.compile(r"^[0-9A-Za-z+\-*/^()., =]{1,200}$")
ALLOWED_NAMES = {
    "sqrt", "sin", "cos", "tan", "asin", "acos", "atan", "log", "ln", "exp",
    "pi", "E", "I", "oo", "abs", "Abs", "diff", "integrate", "factorial",
    "Rational", "simplify", "expand", "factor",
}


def safe(expr):
    if not ALLOWED_CHARS.match(expr) or "__" in expr:
        return False
    for name in re.findall(r"[A-Za-z_][A-Za-z0-9_]*", expr):
        if len(name) == 1 or name in ALLOWED_NAMES:
            continue
        return False
    return True


def main():
    payload = json.load(sys.stdin)
    try:
        import sympy
        from sympy.parsing.sympy_parser import (
            parse_expr, standard_transformations, implicit_multiplication_application,
            convert_xor,
        )
    except ImportError:
        json.dump({"results": ["unverified"] * len(payload["checks"]), "sympy": False}, sys.stdout)
        return

    transformations = standard_transformations + (implicit_multiplication_application, convert_xor)
    local = {"ln": sympy.log, "abs": sympy.Abs}
    results = []
    for c in payload["checks"]:
        lhs, rhs = str(c.get("lhs", "")), str(c.get("rhs", ""))
        if not (safe(lhs) and safe(rhs)):
            results.append("unverified")
            continue
        try:
            a = parse_expr(lhs, local_dict=local, transformations=transformations, evaluate=True)
            b = parse_expr(rhs, local_dict=local, transformations=transformations, evaluate=True)
            diff = sympy.simplify(a - b)
            if diff == 0:
                results.append("verified")
            elif diff.free_symbols:
                results.append("unverified")
            else:
                results.append("mismatch")
        except Exception:
            results.append("unverified")
    json.dump({"results": results, "sympy": True}, sys.stdout)


if __name__ == "__main__":
    main()

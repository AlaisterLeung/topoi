"""Dashboard bundle check: no remote code, and every rendered glyph is vendored.

The bundle is a plain IIFE the Dashboard executes inside the signed-in app, so it must not load code or data from anywhere at runtime. This check is grep-derived rather than a JS parse: it looks for the remote-load and remote-code shapes the bundle could take, then asserts the icon table is complete and every call site resolves against it. It is not a substitute for `node --check` and does not execute the bundle. Run:

    ~/.hermes/hermes-agent/venv/bin/python tests/check_dashboard_bundle.py

"""

from __future__ import annotations

import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[1]
BUNDLE = ROOT / "dashboard" / "dist" / "index.js"
MANIFEST = ROOT / "dashboard" / "manifest.json"

# The patterns are written with character classes so this file does not itself
# trip a repo-wide search for the thing it forbids.
REMOTE_PATTERNS = {
    "CDN URL": re.compile(r"esm[.]sh", re.IGNORECASE),
    "any absolute URL": re.compile(r"https?://"),
    "protocol-relative URL": re.compile(r"//[a-z0-9.-]+[.][a-z]{2,}/", re.IGNORECASE),
}
REMOTE_CODE_PATTERNS = {
    # Every value here is a search pattern, not evaluated code: the point of the
    # check is that these constructs are absent from the bundle.
    "dynamic import": re.compile(r"\bimport\s*[(]"),
    "new Function": re.compile(r"\bnew\s+Function\b"),
    "eval": re.compile(r"\beval\s*[(]"),
    "innerHTML": re.compile(r"\binnerHTML\b"),
    "injected script tag": re.compile(r"createElement\s*\(\s*[\"']script[\"']"),
}

# The glyphs the topics tab renders: badges, row actions, and the edit pair.
EXPECTED_ICONS = {
    "star",
    "package",
    "arrow-up",
    "arrow-down",
    "pencil",
    "house",
    "archive",
    "archive-restore",
    "trash-2",
    "check",
    "x",
}
TAGS = {"path", "rect", "polyline", "line", "circle", "ellipse"}

failures: list[str] = []


def check(name: str, ok: bool, detail: object = "") -> None:
    suffix = f" - {detail}" if detail and not ok else ""
    print(f"{'ok  ' if ok else 'FAIL'} {name}{suffix}")
    if not ok:
        failures.append(name)


def icon_node_lines(source: str) -> dict[str, str]:
    """Return {icon name: source line} for the entries of ICON_NODES."""
    start = source.find("const ICON_NODES = {")
    if start < 0:
        return {}
    end = source.find("\n  };", start)
    block = source[start : end if end > 0 else len(source)]
    entries: dict[str, str] = {}
    for line in block.splitlines():
        hit = re.match(r'\s{4}"([a-z0-9-]+)":', line)
        if hit:
            entries[hit.group(1)] = line
    return entries


def call_site_names(source: str) -> tuple[set[str], set[str]]:
    """Names passed to e(Icon, ...): literals, and whatever dangerIcon may hold.

    Only lines whose trimmed text starts the call are read; a bare `name:` scan
    also matches Input and Button props elsewhere in the file.
    """
    literal: set[str] = set()
    identifiers: set[str] = set()
    for line in source.splitlines():
        if not line.strip().startswith("e(Icon, {"):
            continue
        hit = re.search(r'name:\s*"([a-z0-9-]+)"', line)
        if hit:
            literal.add(hit.group(1))
            continue
        ident = re.search(r"name:\s*([A-Za-z_$][\w$]*)", line)
        if ident:
            identifiers.add(ident.group(1))
    return literal, identifiers


def identifier_values(source: str, identifier: str) -> set[str]:
    """The quoted strings of `const <identifier> = ...;` (the computed icon name)."""
    start = source.find(f"const {identifier} =")
    if start < 0:
        return set()
    # The ternary spans lines and ends before the next statement that uses it.
    end = source.find("\n      actions.push(", start)
    chunk = source[start : end if end > 0 else start + 400]
    return set(re.findall(r'"([a-z0-9-]+)"', chunk))


def main() -> int:
    source = BUNDLE.read_text()
    manifest = json.loads(MANIFEST.read_text())

    check("the bundle exists", BUNDLE.is_file(), BUNDLE)
    check(
        "the bundle is a plain IIFE with no module syntax",
        source.lstrip().startswith("/**")
        and "(function () {" in source
        and not re.search(r"^\s*(?:import|export)\b", source, re.MULTILINE),
    )
    check("the manifest entry is the bundle", manifest.get("entry") == "dist/index.js")
    check("the manifest api is the REST module", manifest.get("api") == "plugin_api.py")

    for label, pattern in REMOTE_PATTERNS.items():
        hit = pattern.search(source)
        check(f"no {label} in the bundle", hit is None, hit.group(0) if hit else "")
        hit = pattern.search(MANIFEST.read_text())
        check(f"no {label} in the manifest", hit is None, hit.group(0) if hit else "")

    for label, pattern in REMOTE_CODE_PATTERNS.items():
        hit = pattern.search(source)
        check(f"no {label} in the bundle", hit is None, hit.group(0) if hit else "")

    check(
        "the old fetch path is gone",
        "ICON_URLS" not in source and "loadIconNode" not in source,
    )

    entries = icon_node_lines(source)
    check(
        "ICON_NODES carries exactly the 11 glyphs",
        set(entries) == EXPECTED_ICONS,
        f"missing {sorted(EXPECTED_ICONS - set(entries))} extra {sorted(set(entries) - EXPECTED_ICONS)}",
    )
    for name, line in sorted(entries.items()):
        parts = re.findall(r'\["([a-z]+)", \{', line)
        check(f'"{name}" has at least one node part', bool(parts), line[:60])
        check(
            f'"{name}" only uses known svg tags',
            set(parts) <= TAGS,
            ",".join(set(parts) - TAGS),
        )
        check(
            f'"{name}" carries no lucide key field',
            "key:" not in line,
            line[:60],
        )

    literal, identifiers = call_site_names(source)
    check(
        "every e(Icon, ...) literal is in ICON_NODES",
        literal <= set(entries),
        sorted(literal - set(entries)),
    )
    check(
        "the only computed icon name is dangerIcon",
        identifiers == {"dangerIcon"},
        ",".join(sorted(identifiers)),
    )
    for identifier in sorted(identifiers):
        values = identifier_values(source, identifier)
        check(
            f"{identifier} only yields vendored glyphs",
            bool(values) and values <= set(entries),
            sorted(values - set(entries)),
        )
        if identifier == "dangerIcon":
            check(
                "dangerIcon branches over archive, archive-restore and trash-2",
                values == {"archive", "archive-restore", "trash-2"},
                sorted(values),
            )
    check(
        "all 11 glyphs are reachable from a call site",
        (literal | set().union(*(identifier_values(source, i) for i in identifiers)))
        == EXPECTED_ICONS,
        sorted(EXPECTED_ICONS - literal),
    )

    check("the ISC licence header is present", "ISC" in source)
    check(
        "the lucide attribution line is present",
        "Cole Bemis" in source and "Contributors 2026" in source,
    )
    check(
        "the ISC permission notice survives",
        "Permission to use, copy, modify, and/or distribute this software" in source,
    )

    print()
    if failures:
        print(f"{len(failures)} check(s) FAILED: {', '.join(failures)}")
        return 1
    print("dashboard bundle checks: all passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

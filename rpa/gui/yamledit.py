"""Edit scalar values in config.yaml without losing its comments.

PyYAML round-trips lose every comment, and config.yaml is documentation as
much as configuration, so the GUI edits it line by line: find the parent
block by indentation, replace the value on the key's line, keep whatever
trailing comment was there. Anything it cannot express (a key nested deeper
than the file already has) is appended as a new line inside the block.
"""

from __future__ import annotations

import re
from typing import Any

import yaml

_KEY_RE = re.compile(r"^(?P<indent>\s*)(?P<key>[A-Za-z0-9_\-]+)\s*:(?P<rest>.*)$")


def format_value(v: Any) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        s = repr(v)
        return s
    if isinstance(v, (list, tuple)):
        return "[" + ", ".join(format_value(x) for x in v) + "]"
    s = str(v)
    if re.fullmatch(r"[A-Za-z0-9_./\-]+", s) and s.lower() not in ("null", "true", "false", "yes", "no", "on", "off", "~") and not re.fullmatch(r"[\d.eE+\-]+", s):
        return s
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _split_value_comment(rest: str) -> tuple[str, str]:
    """'  "a # b"   # comment' -> ('"a # b"', '   # comment')"""
    s = rest
    i = 0
    while i < len(s) and s[i] == " ":
        i += 1
    lead = s[:i]
    body = s[i:]
    if body[:1] in ("'", '"'):
        q = body[0]
        j = 1
        while j < len(body):
            if body[j] == "\\" and q == '"':
                j += 2
                continue
            if body[j] == q:
                break
            j += 1
        return lead + body[: j + 1], body[j + 1 :]
    m = re.search(r"\s+#", body)
    if m:
        return lead + body[: m.start()], body[m.start() :]
    return lead + body.rstrip(), body[len(body.rstrip()) :]


def _block_range(lines: list[str], start: int, indent: int) -> int:
    """Index one past the last line that belongs to the block opened at
    lines[start] (whose children are indented more than `indent`)."""
    i = start + 1
    while i < len(lines):
        ln = lines[i]
        if ln.strip() == "" or ln.lstrip().startswith("#"):
            i += 1
            continue
        cur = len(ln) - len(ln.lstrip(" "))
        if cur <= indent:
            break
        i += 1
    return i


def set_scalar(text: str, keys: list[str], value: Any) -> str:
    lines = text.split("\n")
    parent_indent = -1
    lo, hi = 0, len(lines)
    for depth, key in enumerate(keys):
        found = None
        for i in range(lo, hi):
            m = _KEY_RE.match(lines[i])
            if not m or m.group("key") != key:
                continue
            ind = len(m.group("indent"))
            if ind <= parent_indent:
                break
            if depth == 0 and ind != 0:
                continue
            found = i
            break
        last = depth == len(keys) - 1
        if found is None:
            child_indent = parent_indent + 2 if parent_indent >= 0 else 0
            new = " " * child_indent + key + ":" + (" " + format_value(value) if last else "")
            # insert at the end of the parent block (before trailing blank lines)
            ins = hi
            while ins > lo and lines[ins - 1].strip() == "":
                ins -= 1
            lines.insert(ins, new)
            if last:
                break
            found = ins
            hi = ins + 1
        if last:
            m = _KEY_RE.match(lines[found])
            val, comment = _split_value_comment(m.group("rest"))
            lead = val[: len(val) - len(val.lstrip(" "))] or " "
            lines[found] = m.group("indent") + key + ":" + lead + format_value(value) + comment
        else:
            parent_indent = len(_KEY_RE.match(lines[found]).group("indent"))
            lo = found + 1
            hi = _block_range(lines, found, parent_indent)
    out = "\n".join(lines)
    try:
        got = yaml.safe_load(out) or {}
        for k in keys:
            got = got[k]
    except (yaml.YAMLError, KeyError, TypeError) as e:
        raise ValueError(f"config edit for {'.'.join(keys)} would break config.yaml: {e}") from e
    if got != value and not (isinstance(value, (int, float)) and isinstance(got, (int, float)) and float(got) == float(value)):
        raise ValueError(f"config edit for {'.'.join(keys)} did not round-trip ({got!r} != {value!r})")
    return out


def set_many(text: str, updates: dict[str, Any]) -> str:
    """updates: {'target.apogee_ft': 45000, 'paths.ork': '...'}"""
    for dotted, v in updates.items():
        text = set_scalar(text, dotted.split("."), v)
    return text

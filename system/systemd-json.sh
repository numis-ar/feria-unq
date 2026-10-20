#!/usr/bin/env bash
# systemd-json.sh — convert systemd unit/service files to JSON and back.
# v3: systemctl cat multi-file support.
#
# Usage:
#   systemd-json.sh to-json    <unit-file|-> [output.json|-]
#   systemd-json.sh to-unit    <input.json|-> [output.service|-]
#   systemd-json.sh roundtrip  <unit-file|cat-output>
#   systemd-json.sh --help
#
#   "-" as input reads stdin; "-" (or omitted) as output writes stdout.
#
# Input shapes for to-json:
#   * A single unit file  -> {"Section": {"Key": "Value", ...}, ...}
#   * A `systemctl cat` concatenation (one or more lines of the exact form
#     `# /path/to/file`, as produced by `systemctl cat` / `systemd-analyze
#     cat-config`) -> {"/path/to/file": {"Section": {...}}, ...}
#     This is detected automatically, ONLY IF such a file-reference comment
#     line exists; the path must be the whole comment content, so ordinary
#     comments like "# see /etc/foo for details" do not trigger it.
#
# Behavior:
#   * Duplicate keys in a section become JSON arrays (systemd list semantics).
#   * Duplicate sections are merged; repeated file headers are merged.
#   * Line continuations (\ at end of line) are joined with single spaces;
#     a line after a "\"-terminated line is a continuation even if it has "=".
#   * Comments (# and ;) and blank lines are dropped; key order is preserved.
#   * UTF-8 BOM and CRLF line endings are stripped.
#   * File outputs are written atomically (temp file + rename).
#
# Dependencies: bash 4+, awk (POSIX), jq >= 1.5. No python.
# Limitations: comments/blank lines don't survive the round trip; values
#   containing literal newlines are rejected on to-unit; content preceding
#   the first file header in multi-file input is not supported (systemctl
#   cat never produces that).

set -euo pipefail

die() { echo "error: $*" >&2; exit 1; }

usage() {
    cat <<'EOF'
systemd-json.sh — convert systemd unit/service files to JSON and back.

Usage:
  systemd-json.sh to-json    <unit-file|-> [output.json|-]
  systemd-json.sh to-unit    <input.json|-> [output.service|-]
  systemd-json.sh roundtrip  <unit-file|cat-output>
  systemd-json.sh --help

  "-" as input reads stdin; "-" (or omitted) as output writes stdout.

  to-json accepts either a single unit file, or a `systemctl cat` style
  concatenation whose files are introduced by `# /path/to/file` comment
  lines — in that case the JSON is grouped one level up, with each file
  path as key. Detection is automatic and only triggers on a comment
  consisting solely of a file path.

Dependencies: bash 4+, awk (POSIX), jq >= 1.5. No python.
EOF
}

# --- dependency checks ------------------------------------------------------
command -v awk >/dev/null || die "awk is required but not found in PATH"
command -v jq  >/dev/null || die "jq >= 1.5 is required but not found in PATH"
jq_probe=$( { jq -n 'error("x")'; true; } 2>&1 )
[[ $jq_probe == *': x'* ]] \
    || die "jq >= 1.5 required (found $(jq --version 2>/dev/null || echo unknown))"

# --- helpers ----------------------------------------------------------------

# write_out <output-path|-> : stream stdin to the destination atomically.
write_out() {
    local out=$1 tmp
    if [[ $out == - || -z $out ]]; then
        cat
    else
        tmp=$(mktemp "${TMPDIR:-/tmp}/systemd-json.XXXXXX") \
            || die "cannot create temp file"
        if cat > "$tmp"; then
            mv -f -- "$tmp" "$out" || die "cannot move $tmp into $out"
        else
            rm -f -- "$tmp"; return 1
        fi
    fi
}

# resolve_in <input-path|-> : echo a path awk/jq can open ("-" -> empty).
resolve_in() { [[ $1 == - ]] && printf '' || printf '%s' "$1"; }

# --- unit -> json -----------------------------------------------------------

to_json() {
    local src
    src=$(resolve_in "$1")
    [[ -z $src || -r $src ]] || die "cannot read unit file: $src"
    # awk parses the unit file(s) and emits compact JSON; jq validates/pretty-prints.
    awk '
    function jsonesc(s,    r) {
        r = s
        gsub(/\\/, "\\\\", r)
        gsub(/"/, "\\\"", r)
        gsub(/\t/, "\\t", r)
        gsub(/\r/, "\\r", r)
        gsub(/\n/, "\\n", r)
        return "\"" r "\""
    }
    # all parse state is namespaced by the current file cf:
    # sections per (cf,s), keys per (cf,s), values per (cf,s,k)
    function flush(   s,k,kk,v) {
        if (pkey == "") return
        s = (psec == "" ? "_" : psec)
        k = pkey
        v = pbuf
        gsub(/^[ \t]+|[ \t]+$/, "", v)
        if (!((cf, s) in seen_sec)) { seen_sec[cf, s] = 1; sec_order[cf, nsec[cf]++] = s }
        kk = cf SUBSEP s SUBSEP k
        if (kk in count) { count[kk]++; vals[kk, count[kk]] = v }
        else { count[kk] = 1; vals[kk, 1] = v; korder[cf, s, nkeys[cf, s]++] = k }
        pkey = ""
    }
    # print the section-object for one file at the given indent (no braces)
    function emit_sections(f, ind,   i,j,s,k,kk,t,ksep) {
        for (i = 0; i < nsec[f]; i++) {
            if (i) print ","
            s = sec_order[f, i]
            printf "%s%s: {\n", ind, jsonesc(s)
            for (j = 0; j < nkeys[f, s]; j++) {
                k = korder[f, s, j]; kk = f SUBSEP s SUBSEP k
                ksep = (j < nkeys[f, s] - 1) ? "," : ""
                printf "%s  %s: ", ind, jsonesc(k)
                if (count[kk] == 1) {
                    print jsonesc(vals[kk, 1]) ksep
                } else {
                    printf "["
                    for (t = 1; t <= count[kk]; t++)
                        printf "%s%s", jsonesc(vals[kk, t]), (t < count[kk] ? ", " : "")
                    print "]" ksep
                }
            }
            printf "%s}", ind
        }
    }
    {
        line = $0
        if (NR == 1) sub(/^\xef\xbb\xbf/, "", line)   # UTF-8 BOM
        gsub(/^[ \t\r]+|[ \t\r]+$/, "", line)         # trim + CRLF

        # systemctl cat / cat-config file header: "# /path/to/file" and
        # nothing else on the line. Detected before the generic comment skip.
        if (line ~ /^#[ \t]*\/[^ \t]+[ \t]*$/) {
            flush()
            f = line
            sub(/^#[ \t]*/, "", f)
            sub(/[ \t]*$/, "", f)
            if (!(f in fseen)) { fseen[f] = 1; files_order[nf++] = f }
            cf = f
            next
        }

        if (line == "" || line ~ /^[#;]/) next
        if (!cont && line ~ /^\[.*\]$/) {
            flush()
            psec = substr(line, 2, length(line) - 2)
            gsub(/^[ \t]+|[ \t]+$/, "", psec)
            next
        }
        if (!cont && index(line, "=") > 0) {
            flush()
            p = index(line, "=")
            pkey = substr(line, 1, p - 1)
            gsub(/^[ \t]+|[ \t]+$/, "", pkey)
            v = substr(line, p + 1)
            gsub(/^[ \t]+|[ \t]+$/, "", v)
            if (v ~ /\\$/) { cont = 1; pbuf = substr(v, 1, length(v) - 1); sub(/[ \t]+$/, "", pbuf) }
            else           { cont = 0; pbuf = v; flush() }
        } else if (pkey != "") {
            # continuation line (previous line ended with "\")
            if (line ~ /\\$/) { cont = 1; c = substr(line, 1, length(line) - 1); sub(/[ \t]+$/, "", c); pbuf = pbuf " " c }
            else              { cont = 0; pbuf = pbuf " " line; flush() }
        }
    }
    END {
        flush()
        if (nf == 0) {
            # single unit file: top level is the section-object
            if (nsec[""] == 0) print "{}"
            else { print "{"; emit_sections("", "  "); print ""; print "}" }
        } else {
            # systemctl cat concatenation: top level is {"path": {sections}}
            print "{"
            for (i = 0; i < nf; i++) {
                f = files_order[i]
                if (i) print ","
                printf "  %s: ", jsonesc(f)
                if (nsec[f] == 0) print "{}"
                else { print "{"; emit_sections(f, "    "); print ""; print "  }" }
            }
            print "}"
        }
    }' $src | jq .
}

# --- json -> unit -----------------------------------------------------------

to_unit() {
    local src tmp= rc
    src=$(resolve_in "$1")
    if [[ -z $src ]]; then
        # two passes are needed (validate, then emit); buffer stdin to a temp file
        tmp=$(mktemp "${TMPDIR:-/tmp}/systemd-json.XXXXXX") \
            || die "cannot create temp file"
        if ! cat > "$tmp"; then
            rm -f -- "$tmp"; die "failed to buffer stdin"
        fi
        src=$tmp
    fi
    if [[ ! -r $src ]]; then
        [[ -n $tmp ]] && rm -f -- "$tmp"
        die "cannot read JSON file: $src"
    fi

    # multi-file shape detection: every top-level key is an absolute path
    # (single-file shape has section names like "Unit", never starting "/")
    local detect='length > 0 and (keys | all(.[0:1] == "/"))'

    # pass 1: validate structure so we never emit a half-written unit file.
    local vprog='
        def unitbody:
            to_entries[]
            | if (.value | type) != "object"
                  then error("section \"" + .key + "\" must map to an object") else . end
            | .value | to_entries[] | .key as $k
            | (.value | if type == "array" then .[] else . end)
            | if (type == "object") or (type == "array") or (type == "null") then
                  error("value for \"" + $k + "\" must be a string or an array of strings")
              elif (tostring | test("\n")) then
                  error("value for \"" + $k + "\" contains a newline (not valid in unit files)")
              else empty end;
        if type != "object" then error("top-level JSON value must be an object") else . end
        | if ('"$detect"') then
              to_entries[]
              | if (.value | type) != "object" then error("file \"" + .key + "\" must map to an object") else . end
              | .value | unitbody
          else unitbody end'
    # pass 2: emit (input already validated).
    local prog='
        def unitbody:
            to_entries[]
            | (if .key == "_" then empty else "[" + .key + "]" end),
              (.value
                  | to_entries[]
                  | .key as $k
                  | (.value | if type == "array" then .[] else . end)
                  | "\($k)=\(tostring)"),
              "";
        if ('"$detect"') then
            to_entries[]
            | "# " + .key, "",
              (.value | unitbody), ""
        else unitbody end'

    # run both passes; clean up the buffer regardless of outcome
    if jq -r "$vprog" < "$src" >/dev/null && jq -r "$prog" < "$src"; then
        rc=0
    else
        rc=1
    fi
    [[ -n $tmp ]] && rm -f -- "$tmp"
    return $rc
}

# --- round trip -------------------------------------------------------------

roundtrip() {
    local src=$1
    [[ -r $src ]] || die "cannot read unit file: $src"
    RT_TMP=$(mktemp -d)
    trap 'rm -rf "$RT_TMP"' EXIT
    to_json "$src"               > "$RT_TMP/1.json"
    to_unit "$RT_TMP/1.json"     > "$RT_TMP/back.service"
    to_json "$RT_TMP/back.service" > "$RT_TMP/2.json"
    echo "--- JSON ---"
    cat "$RT_TMP/1.json"
    echo "--- regenerated concatenation ---"
    cat "$RT_TMP/back.service"
    echo "--- diff: JSON before vs after round trip ---"
    if diff "$RT_TMP/1.json" "$RT_TMP/2.json"; then
        echo "OK: round trip is lossless (modulo comments/blank lines)"
    else
        echo "WARNING: round trip differs" >&2
        return 1
    fi
}

# --- driver -----------------------------------------------------------------

cmd=${1:-}; shift || true
case $cmd in
    to-json)   [[ $# -ge 1 ]] || die "usage: $0 to-json <unit-file|-> [output.json|-]"
               to_json "$1" | write_out "${2:--}" ;;
    to-unit)   [[ $# -ge 1 ]] || die "usage: $0 to-unit <input.json|-> [output.service|-]"
               to_unit "$1" | write_out "${2:--}" ;;
    roundtrip) [[ $# -ge 1 ]] || die "usage: $0 roundtrip <unit-file|cat-output>"
               roundtrip "$1" ;;
    -h|--help|help) usage ;;
    *) die "usage: $0 {to-json|to-unit|roundtrip|--help} ..." ;;
esac

